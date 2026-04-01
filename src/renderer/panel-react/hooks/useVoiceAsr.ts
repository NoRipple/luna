import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResult, VoiceAsrEvent } from '../types';

const TARGET_ASR_SAMPLE_RATE = 16000;

function getAudioContextCtor() {
  return window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null;
}

function downsamplePcmBuffer(input: Float32Array, inputSampleRate: number, targetSampleRate: number) {
  if (!(input instanceof Float32Array)) return new Float32Array();
  if (!Number.isFinite(inputSampleRate) || !Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    return new Float32Array(input);
  }
  if (inputSampleRate <= targetSampleRate) {
    return new Float32Array(input);
  }
  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  let outputOffset = 0;
  let inputOffset = 0;
  while (outputOffset < outputLength) {
    const nextInputOffset = Math.round((outputOffset + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = inputOffset; i < nextInputOffset && i < input.length; i += 1) {
      sum += input[i];
      count += 1;
    }
    output[outputOffset] = count > 0 ? sum / count : 0;
    outputOffset += 1;
    inputOffset = nextInputOffset;
  }
  return output;
}

function encodePcm16LittleEndian(float32Pcm: Float32Array) {
  if (!(float32Pcm instanceof Float32Array) || float32Pcm.length === 0) {
    return new Uint8Array();
  }
  const buffer = new ArrayBuffer(float32Pcm.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Pcm.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Pcm[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

type SendCommand = (text: string, options?: { keepInputOnFailure?: boolean }) => Promise<void>;

export function useVoiceAsr(sendCommand: SendCommand, getDraft: () => string, setDraft: (value: string) => void) {
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [metaText, setMetaText] = useState('语音输入未开启');
  const [metaState, setMetaState] = useState<'idle' | 'recording' | 'error'>('idle');
  const [unsupportedReason, setUnsupportedReason] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const pendingSubmitRef = useRef(false);
  const draftBeforeRecordingRef = useRef('');
  const transcriptFinalRef = useRef('');
  const transcriptPartialRef = useRef('');
  const recordingRef = useRef(false);
  const stoppingRef = useRef(false);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    stoppingRef.current = stopping;
  }, [stopping]);

  const resolveUnsupportedReason = useCallback(() => {
    const AudioContextCtor = getAudioContextCtor();
    if (!window.electronAPI?.voiceAsrStart || !window.electronAPI?.voiceAsrSendAudioFrame || !window.electronAPI?.voiceAsrStop) {
      return '语音 IPC 通道不可用';
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return '当前环境不支持麦克风采集';
    }
    if (!AudioContextCtor) {
      return '当前环境不支持音频处理';
    }
    return '';
  }, []);

  const buildVoicePreviewText = useCallback(() => {
    const finalText = String(transcriptFinalRef.current || '').trim();
    const partialText = String(transcriptPartialRef.current || '').trim();
    if (finalText && partialText) return `${finalText}\n${partialText}`.trim();
    return (finalText || partialText || '').trim();
  }, []);

  const syncVoiceDraftToInput = useCallback(() => {
    if (!recordingRef.current && !stoppingRef.current) return;
    const transcript = buildVoicePreviewText();
    const prefix = String(draftBeforeRecordingRef.current || '').trim();
    if (!transcript) {
      setDraft(draftBeforeRecordingRef.current);
      return;
    }
    setDraft(prefix ? `${prefix}\n${transcript}` : transcript);
  }, [buildVoicePreviewText, setDraft]);

  const stopVoiceCaptureGraph = useCallback(async () => {
    try { processorNodeRef.current?.disconnect(); } catch {}
    try { sourceNodeRef.current?.disconnect(); } catch {}
    try { gainNodeRef.current?.disconnect(); } catch {}
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
    if (audioContextRef.current) {
      try { await audioContextRef.current.close(); } catch {}
    }
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    gainNodeRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
  }, []);

  const startVoiceCaptureGraph = useCallback(async (stream: MediaStream) => {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      throw new Error('当前环境不支持音频处理');
    }

    const context = new AudioContextCtor();
    if (context.state === 'suspended') {
      await context.resume();
    }
    const sourceNode = context.createMediaStreamSource(stream);
    const processorNode = context.createScriptProcessor(4096, 1, 1);
    const gainNode = context.createGain();
    gainNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!recordingRef.current) return;
      const channelData = event.inputBuffer.getChannelData(0);
      const sampled = downsamplePcmBuffer(channelData, context.sampleRate, TARGET_ASR_SAMPLE_RATE);
      const pcm16 = encodePcm16LittleEndian(sampled);
      if (!pcm16.length) return;
      window.electronAPI?.voiceAsrSendAudioFrame?.(pcm16);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(gainNode);
    gainNode.connect(context.destination);

    audioContextRef.current = context;
    sourceNodeRef.current = sourceNode;
    processorNodeRef.current = processorNode;
    gainNodeRef.current = gainNode;
  }, []);

  const appendVoiceFinalText = useCallback((text: string) => {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    transcriptFinalRef.current = transcriptFinalRef.current
      ? `${transcriptFinalRef.current}\n${normalized}`
      : normalized;
    transcriptPartialRef.current = '';
    syncVoiceDraftToInput();
  }, [syncVoiceDraftToInput]);

  const finalizeVoiceCapture = useCallback(async () => {
    if (!recordingRef.current && !stoppingRef.current) return;
    const transcript = buildVoicePreviewText().trim();
    const shouldSubmit = pendingSubmitRef.current;
    const fallbackDraft = draftBeforeRecordingRef.current;
    setRecording(false);
    setStopping(false);
    pendingSubmitRef.current = false;

    if (!transcript) {
      setDraft(fallbackDraft);
      setMetaText('未识别到有效语音');
      setMetaState('idle');
    } else {
      setDraft(transcript);
      if (shouldSubmit) {
        await sendCommand(transcript, { keepInputOnFailure: true });
        if (getDraft().trim() === transcript) {
          setDraft('');
        }
        setMetaText('语音命令已发送');
      } else {
        setMetaText('语音识别完成');
      }
      setMetaState('idle');
    }

    draftBeforeRecordingRef.current = '';
    transcriptFinalRef.current = '';
    transcriptPartialRef.current = '';
  }, [buildVoicePreviewText, getDraft, sendCommand, setDraft]);

  const startVoiceInput = useCallback(async () => {
    if (recordingRef.current || stoppingRef.current) return;
    const reason = resolveUnsupportedReason();
    setUnsupportedReason(reason);
    if (reason) {
      setMetaText(`语音不可用：${reason}`);
      setMetaState('error');
      return;
    }

    setStopping(true);
    setMetaText('正在启动语音识别...');
    setMetaState('idle');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_ASR_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const started = await window.electronAPI?.voiceAsrStart?.({
        format: 'pcm',
        sampleRate: TARGET_ASR_SAMPLE_RATE
      }) as CommandResult | undefined;
      if (!started?.ok) {
        throw new Error(started?.message || '语音识别服务启动失败');
      }

      streamRef.current = stream;
      await startVoiceCaptureGraph(stream);
      draftBeforeRecordingRef.current = getDraft();
      transcriptFinalRef.current = '';
      transcriptPartialRef.current = '';
      pendingSubmitRef.current = false;
      setRecording(true);
      setStopping(false);
      setMetaText('语音输入中...');
      setMetaState('recording');
    } catch (error) {
      if (stream) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      await stopVoiceCaptureGraph();
      await window.electronAPI?.voiceAsrAbort?.().catch(() => {});
      setRecording(false);
      setStopping(false);
      setMetaText(`语音输入启动失败: ${String((error as Error)?.message || error)}`);
      setMetaState('error');
    }
  }, [getDraft, resolveUnsupportedReason, startVoiceCaptureGraph, stopVoiceCaptureGraph]);

  const stopVoiceInput = useCallback(async (submit = true) => {
    if (!recordingRef.current && !stoppingRef.current) return;
    pendingSubmitRef.current = submit;
    setRecording(false);
    setStopping(true);
    setMetaText('正在结束语音识别...');
    setMetaState('idle');

    await stopVoiceCaptureGraph();
    try {
      const stopResult = await window.electronAPI?.voiceAsrStop?.();
      if (!stopResult?.ok) {
        throw new Error(stopResult?.message || '语音识别停止失败');
      }
    } catch (error) {
      await window.electronAPI?.voiceAsrAbort?.().catch(() => {});
      setMetaText(`停止语音识别失败: ${String((error as Error)?.message || error)}`);
      setMetaState('error');
    }
    await finalizeVoiceCapture();
  }, [finalizeVoiceCapture, stopVoiceCaptureGraph]);

  const handleAsrEvent = useCallback(async (payload: VoiceAsrEvent = {}) => {
    const eventType = String(payload?.type || '');
    if (!eventType) return;

    if (eventType === 'started') {
      setMetaText('语音识别通道已建立');
      setMetaState('recording');
      return;
    }
    if (eventType === 'result') {
      if (!recordingRef.current && !stoppingRef.current) return;
      const text = String(payload?.text || '');
      if (!text.trim()) return;
      if (payload?.isFinal) {
        appendVoiceFinalText(text);
      } else {
        transcriptPartialRef.current = text;
        syncVoiceDraftToInput();
      }
      return;
    }
    if (eventType === 'error') {
      const message = String(payload?.message || '语音识别发生错误');
      setMetaText(`语音错误：${message}`);
      setMetaState('error');
      if (recordingRef.current) {
        await stopVoiceInput(false);
      }
      return;
    }
    if (eventType === 'closed') {
      if (stoppingRef.current || recordingRef.current) {
        await finalizeVoiceCapture();
      }
    }
  }, [appendVoiceFinalText, finalizeVoiceCapture, stopVoiceInput, syncVoiceDraftToInput]);

  useEffect(() => {
    const reason = resolveUnsupportedReason();
    setUnsupportedReason(reason);
    if (reason) {
      setMetaText(`语音不可用：${reason}`);
      setMetaState('error');
    }
  }, [resolveUnsupportedReason]);

  useEffect(() => {
    if (!window.electronAPI?.onVoiceAsrEvent) return;
    window.electronAPI.onVoiceAsrEvent((payload) => {
      handleAsrEvent(payload).catch(() => {});
    });
  }, [handleAsrEvent]);

  useEffect(() => {
    return () => {
      stopVoiceCaptureGraph().catch(() => {});
      const abortPromise = window.electronAPI?.voiceAsrAbort?.();
      if (abortPromise && typeof (abortPromise as Promise<unknown>).catch === 'function') {
        (abortPromise as Promise<unknown>).catch(() => {});
      }
    };
  }, [stopVoiceCaptureGraph]);

  const buttonTitle = useMemo(() => {
    if (unsupportedReason) return unsupportedReason;
    if (recording) return '停止并发送语音命令';
    return '开始语音输入';
  }, [recording, unsupportedReason]);

  return {
    recording,
    stopping,
    unsupportedReason,
    metaText,
    metaState,
    buttonTitle,
    startVoiceInput,
    stopVoiceInput
  };
}
