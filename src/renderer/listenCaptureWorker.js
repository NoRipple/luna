/* 主要职责：隐藏页音频采集 Worker，并行抓取系统音频+麦克风并分别输出 16k PCM 帧。 */
const { ipcRenderer } = require('electron');

function downsamplePcmBuffer(input, inputSampleRate, targetSampleRate) {
    if (!(input instanceof Float32Array)) return new Float32Array();
    if (!Number.isFinite(inputSampleRate) || !Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
        return new Float32Array(input);
    }
    if (inputSampleRate === targetSampleRate) {
        return new Float32Array(input);
    }
    if (inputSampleRate < targetSampleRate) {
        return new Float32Array(input);
    }

    const ratio = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);
    let inputOffset = 0;
    for (let i = 0; i < outputLength; i += 1) {
        const nextOffset = Math.round((i + 1) * ratio);
        let sum = 0;
        let count = 0;
        for (let j = inputOffset; j < nextOffset && j < input.length; j += 1) {
            sum += input[j];
            count += 1;
        }
        output[i] = count > 0 ? sum / count : 0;
        inputOffset = nextOffset;
    }
    return output;
}

function encodePcm16LittleEndian(float32Pcm) {
    if (!(float32Pcm instanceof Float32Array) || float32Pcm.length === 0) {
        return Buffer.alloc(0);
    }
    const output = Buffer.alloc(float32Pcm.length * 2);
    for (let i = 0; i < float32Pcm.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, float32Pcm[i]));
        const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
        output.writeInt16LE(int16, i * 2);
    }
    return output;
}

const state = {
    sessionId: '',
    running: false,
    targetSampleRate: 16000,
    audioContext: null,
    systemStream: null,
    micStream: null,
    systemSourceNode: null,
    micSourceNode: null,
    systemProcessorNode: null,
    micProcessorNode: null,
    systemSinkGainNode: null,
    micSinkGainNode: null,
    stopTimer: null
};

function emitStatus(status, extra = {}) {
    ipcRenderer.send('listen-capture-status', {
        sessionId: state.sessionId,
        status,
        ...extra
    });
}

function emitError(message, extra = {}) {
    ipcRenderer.send('listen-capture-error', {
        sessionId: state.sessionId,
        message: String(message || 'capture failed'),
        ...extra
    });
}

function emitComplete(reason = 'completed') {
    ipcRenderer.send('listen-capture-complete', {
        sessionId: state.sessionId,
        reason
    });
}

async function getSystemAudioStream(systemSourceId) {
    const sourceId = String(systemSourceId || '').trim();
    if (!sourceId) {
        throw new Error('系统音频采集失败：缺少屏幕源 ID');
    }
    const constraints = {
        audio: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId
            }
        },
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId,
                minWidth: 1,
                maxWidth: 2,
                minHeight: 1,
                maxHeight: 2,
                maxFrameRate: 1
            }
        }
    };
    return navigator.mediaDevices.getUserMedia(constraints);
}

async function getMicrophoneStream() {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        },
        video: false
    });
}

async function cleanupCapture() {
    if (state.stopTimer) {
        clearTimeout(state.stopTimer);
        state.stopTimer = null;
    }
    if (state.systemProcessorNode) {
        try { state.systemProcessorNode.disconnect(); } catch (_error) {}
        state.systemProcessorNode.onaudioprocess = null;
    }
    if (state.micProcessorNode) {
        try { state.micProcessorNode.disconnect(); } catch (_error) {}
        state.micProcessorNode.onaudioprocess = null;
    }
    if (state.systemSourceNode) {
        try { state.systemSourceNode.disconnect(); } catch (_error) {}
    }
    if (state.micSourceNode) {
        try { state.micSourceNode.disconnect(); } catch (_error) {}
    }
    if (state.systemSinkGainNode) {
        try { state.systemSinkGainNode.disconnect(); } catch (_error) {}
    }
    if (state.micSinkGainNode) {
        try { state.micSinkGainNode.disconnect(); } catch (_error) {}
    }
    if (state.systemStream) {
        for (const track of state.systemStream.getTracks()) {
            try { track.stop(); } catch (_error) {}
        }
    }
    if (state.micStream) {
        for (const track of state.micStream.getTracks()) {
            try { track.stop(); } catch (_error) {}
        }
    }
    if (state.audioContext) {
        try { await state.audioContext.close(); } catch (_error) {}
    }

    state.running = false;
    state.audioContext = null;
    state.systemStream = null;
    state.micStream = null;
    state.systemSourceNode = null;
    state.micSourceNode = null;
    state.systemProcessorNode = null;
    state.micProcessorNode = null;
    state.systemSinkGainNode = null;
    state.micSinkGainNode = null;
}

async function stopCapture(reason = 'stopped') {
    if (!state.running) return;
    await cleanupCapture();
    emitComplete(reason);
}

async function startCapture(payload = {}) {
    const nextSessionId = String(payload?.sessionId || '').trim();
    if (!nextSessionId) {
        emitError('缺少 sessionId');
        return;
    }
    if (state.running) {
        await stopCapture('replaced');
    }

    state.sessionId = nextSessionId;
    state.targetSampleRate = Math.max(8000, Number(payload?.sampleRate || 16000));
    const seconds = Math.max(1, Math.min(10, Number(payload?.seconds || 5)));

    emitStatus('starting', { seconds, sampleRate: state.targetSampleRate });
    try {
        const [systemStream, micStream] = await Promise.all([
            getSystemAudioStream(payload?.systemSourceId),
            getMicrophoneStream()
        ]);

        const systemAudioTracks = systemStream.getAudioTracks();
        const micAudioTracks = micStream.getAudioTracks();
        if (!Array.isArray(systemAudioTracks) || systemAudioTracks.length === 0) {
            throw new Error('系统音频采集失败：未获取到系统音频轨道');
        }
        if (!Array.isArray(micAudioTracks) || micAudioTracks.length === 0) {
            throw new Error('麦克风采集失败：未获取到麦克风音频轨道');
        }

        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            throw new Error('当前环境不支持 AudioContext');
        }
        const audioContext = new AudioContextCtor();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const systemSourceNode = audioContext.createMediaStreamSource(systemStream);
        const micSourceNode = audioContext.createMediaStreamSource(micStream);
        const systemProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
        const micProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
        const systemSinkGainNode = audioContext.createGain();
        const micSinkGainNode = audioContext.createGain();
        systemSinkGainNode.gain.value = 0;
        micSinkGainNode.gain.value = 0;

        systemProcessorNode.onaudioprocess = (event) => {
            if (!state.running) return;
            const input = event.inputBuffer.getChannelData(0);
            const sampled = downsamplePcmBuffer(input, audioContext.sampleRate, state.targetSampleRate);
            const frame = encodePcm16LittleEndian(sampled);
            if (!frame || frame.length === 0) return;
            ipcRenderer.send('listen-capture-frame', {
                sessionId: state.sessionId,
                source: 'system',
                frame
            });
        };

        micProcessorNode.onaudioprocess = (event) => {
            if (!state.running) return;
            const input = event.inputBuffer.getChannelData(0);
            const sampled = downsamplePcmBuffer(input, audioContext.sampleRate, state.targetSampleRate);
            const frame = encodePcm16LittleEndian(sampled);
            if (!frame || frame.length === 0) return;
            ipcRenderer.send('listen-capture-frame', {
                sessionId: state.sessionId,
                source: 'mic',
                frame
            });
        };

        systemSourceNode.connect(systemProcessorNode);
        systemProcessorNode.connect(systemSinkGainNode);
        systemSinkGainNode.connect(audioContext.destination);

        micSourceNode.connect(micProcessorNode);
        micProcessorNode.connect(micSinkGainNode);
        micSinkGainNode.connect(audioContext.destination);

        state.running = true;
        state.audioContext = audioContext;
        state.systemStream = systemStream;
        state.micStream = micStream;
        state.systemSourceNode = systemSourceNode;
        state.micSourceNode = micSourceNode;
        state.systemProcessorNode = systemProcessorNode;
        state.micProcessorNode = micProcessorNode;
        state.systemSinkGainNode = systemSinkGainNode;
        state.micSinkGainNode = micSinkGainNode;

        state.stopTimer = setTimeout(() => {
            stopCapture('duration_reached').catch((error) => {
                emitError(error?.message || String(error || 'stop failed'));
            });
        }, Math.round(seconds * 1000));

        emitStatus('recording', { seconds });
    } catch (error) {
        await cleanupCapture();
        const name = String(error?.name || '').trim();
        const message = String(error?.message || error || 'capture start failed').trim();
        const detail = [name, message].filter(Boolean).join(': ');
        emitError(detail || 'capture start failed');
    }
}

ipcRenderer.on('listen-capture-start', (_event, payload) => {
    startCapture(payload).catch((error) => {
        emitError(error?.message || String(error || 'capture start failed'));
    });
});

ipcRenderer.on('listen-capture-stop', (_event, payload = {}) => {
    const sessionId = String(payload?.sessionId || '').trim();
    if (sessionId && sessionId !== state.sessionId) return;
    stopCapture('stopped_by_host').catch((error) => {
        emitError(error?.message || String(error || 'capture stop failed'));
    });
});

ipcRenderer.send('listen-capture-worker-ready', {
    ready: true
});
