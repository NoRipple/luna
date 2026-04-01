#!/usr/bin/env node
/* 命令行流式 TTS 测试脚本：输入文本，调用本地 TTS 服务并实时播放。 */
const { spawn } = require('child_process');
const readline = require('readline');
const { performance } = require('perf_hooks');
const config = require('../src/config/runtimeConfig');

function parseArgs(argv) {
    const args = {
        url: config.tts?.baseUrl || 'http://127.0.0.1:3101/v1/t2a_v2',
        apiKey: config.tts?.apiKey || '',
        model: config.tts?.model || 'genie-v2proplus',
        voiceId: config.tts?.voiceId || 'mika',
        ffplay: process.env.TTS_FFPLAY_PATH || 'ffplay',
        timeoutMs: Number(process.env.TTS_TEST_TIMEOUT_MS || 120000),
        text: '',
        help: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help' || token === '-h') {
            args.help = true;
        } else if (token === '--url') {
            args.url = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--api-key') {
            args.apiKey = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--model') {
            args.model = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--voice') {
            args.voiceId = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--ffplay') {
            args.ffplay = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--timeout-ms') {
            const ms = Number(argv[i + 1]);
            if (Number.isFinite(ms) && ms > 0) {
                args.timeoutMs = ms;
            }
            i += 1;
        } else if (token === '--text' || token === '-t') {
            args.text = String(argv[i + 1] || '');
            i += 1;
        }
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  npm run tts:test',
            '  npm run tts:test -- --text "こんにちは、テストです。"',
            '',
            'Options:',
            '  --text, -t   Single text mode; synth once and exit',
            '  --url        TTS endpoint URL',
            '  --api-key    Authorization Bearer token (optional)',
            '  --model      Model name in request payload',
            '  --voice      Voice ID in request payload',
            '  --ffplay     ffplay executable path',
            '  --timeout-ms Request timeout in milliseconds (default 120000)',
            '  --help, -h   Show help'
        ].join('\n')
    );
}

async function writeWithBackpressure(stream, chunk) {
    if (stream.write(chunk)) return;
    await new Promise((resolve) => stream.once('drain', resolve));
}

async function playTextStreaming({
    url,
    apiKey,
    model,
    voiceId,
    ffplayPath,
    timeoutMs,
    text
}) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return;

    let ffplay = null;
    let ffplayClosed = null;
    let ffplayStderr = '';

    const ensureFfplay = () => {
        if (ffplay) return;
        ffplay = spawn(
            ffplayPath,
            ['-nodisp', '-autoexit', '-loglevel', 'error', '-i', 'pipe:0'],
            { stdio: ['pipe', 'inherit', 'pipe'], windowsHide: true }
        );
        ffplay.stderr.on('data', (chunk) => {
            ffplayStderr += String(chunk || '');
        });
        ffplayClosed = new Promise((resolve, reject) => {
            ffplay.on('error', (error) => reject(error));
            ffplay.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`ffplay exit code=${code}; stderr=${ffplayStderr.trim()}`));
            });
        });
    };

    const payload = {
        model,
        text: normalizedText,
        stream: true,
        stream_options: {
            exclude_aggregated_audio: true
        },
        voice_setting: {
            voice_id: voiceId,
            speed: 1,
            vol: 1,
            pitch: 0
        },
        audio_setting: {
            format: 'mp3',
            sample_rate: 32000,
            channel: 1
        }
    };

    const headers = {
        'Content-Type': 'application/json'
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const startedAt = performance.now();
    const controller = new AbortController();
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
    const timeoutHandle = setTimeout(() => controller.abort(), safeTimeoutMs);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }
        if (!response.body) {
            throw new Error('response body is empty');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let chunkCount = 0;
        let chunkBytes = 0;
        let firstAudioAt = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (!jsonStr) continue;

                let eventPayload;
                try {
                    eventPayload = JSON.parse(jsonStr);
                } catch (error) {
                    continue;
                }

                if (eventPayload?.base_resp?.status_code && eventPayload.base_resp.status_code !== 0) {
                    throw new Error(`TTS error: ${JSON.stringify(eventPayload.base_resp)}`);
                }

                const hexAudio = String(eventPayload?.data?.audio || '');
                if (!hexAudio) continue;

                const audioBuffer = Buffer.from(hexAudio, 'hex');
                if (!audioBuffer.length) continue;

                ensureFfplay();
                if (!firstAudioAt) {
                    firstAudioAt = performance.now();
                }
                chunkCount += 1;
                chunkBytes += audioBuffer.length;
                await writeWithBackpressure(ffplay.stdin, audioBuffer);
            }
        }

        if (ffplay) {
            ffplay.stdin.end();
            await ffplayClosed;
        }

        const endedAt = performance.now();
        const firstAudioMs = firstAudioAt ? (firstAudioAt - startedAt).toFixed(1) : 'n/a';
        const totalMs = (endedAt - startedAt).toFixed(1);
        console.log(
            `[tts:test] done | text_len=${normalizedText.length} | chunks=${chunkCount} | bytes=${chunkBytes} | first_audio_ms=${firstAudioMs} | total_ms=${totalMs}`
        );
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`request timeout (${safeTimeoutMs}ms)`);
        }
        if (error?.cause?.code === 'ECONNREFUSED') {
            throw new Error(`cannot connect to ${url}; 请先启动主程序 (npm start)`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
        if (ffplay && !ffplay.killed) {
            try {
                ffplay.stdin.end();
            } catch (error) {
                // ignore
            }
        }
    }
}

async function runInteractive(args) {
    console.log(`[tts:test] endpoint=${args.url}`);
    console.log('[tts:test] 输入文本后回车播放；输入 /exit 退出。');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'tts> '
    });

    rl.prompt();
    rl.on('line', async (line) => {
        const text = String(line || '').trim();
        if (!text) {
            rl.prompt();
            return;
        }
        if (text === '/exit' || text === '/quit') {
            rl.close();
            return;
        }

        rl.pause();
        try {
            await playTextStreaming({
                url: args.url,
                apiKey: args.apiKey,
                model: args.model,
                voiceId: args.voiceId,
                ffplayPath: args.ffplay,
                timeoutMs: args.timeoutMs,
                text
            });
        } catch (error) {
            console.error(`[tts:test] failed: ${error?.message || error}`);
        } finally {
            rl.resume();
            rl.prompt();
        }
    });

    await new Promise((resolve) => rl.on('close', resolve));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    if (args.text) {
        await playTextStreaming({
            url: args.url,
            apiKey: args.apiKey,
            model: args.model,
            voiceId: args.voiceId,
            ffplayPath: args.ffplay,
            timeoutMs: args.timeoutMs,
            text: args.text
        });
        return;
    }

    await runInteractive(args);
}

main().catch((error) => {
    console.error(`[tts:test] fatal: ${error?.message || error}`);
    process.exitCode = 1;
});
