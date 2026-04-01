#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Genie-TTS worker process for local MiniMax-compatible proxy."""

import argparse
import asyncio
import base64
import json
import os
import sys
import traceback
import uuid

PREFIX = "@@GENIE@@"


def emit(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--character", default="mika")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--genie-data-dir", default="")
    return parser.parse_args()


async def synthesize_stream(genie, character_name, text, request_id):
    async for chunk in genie.tts_async(
        character_name=character_name,
        text=text,
        play=False,
        split_sentence=True,
        save_path=None,
    ):
        if not chunk:
            continue
        emit(
            {
                "type": "audio_chunk",
                "ok": True,
                "id": request_id,
                "pcm_b64": base64.b64encode(chunk).decode("ascii"),
                "pcm_bytes": len(chunk),
            }
        )


def main():
    args = parse_args()
    project_dir = os.path.abspath(args.project_dir)
    output_dir = os.path.abspath(args.output_dir)
    genie_data_dir = os.path.abspath(args.genie_data_dir) if args.genie_data_dir else ""

    os.makedirs(output_dir, exist_ok=True)
    os.chdir(project_dir)

    if genie_data_dir:
        os.environ["GENIE_DATA_DIR"] = genie_data_dir
    elif "GENIE_DATA_DIR" not in os.environ:
        os.environ["GENIE_DATA_DIR"] = os.path.join(project_dir, "GenieData")

    try:
        import genie_tts as genie  # pylint: disable=import-error

        genie.load_predefined_character(args.character)
    except Exception as error:  # pragma: no cover
        emit(
            {
                "type": "boot_error",
                "ok": False,
                "error": str(error),
                "traceback": traceback.format_exc(),
            }
        )
        return 1

    emit(
        {
            "type": "ready",
            "ok": True,
            "character": args.character,
            "project_dir": project_dir,
            "output_dir": output_dir,
            "genie_data_dir": os.environ.get("GENIE_DATA_DIR", ""),
        }
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except Exception:
            emit({"type": "worker_error", "ok": False, "error": "invalid_json"})
            continue

        request_type = str(request.get("type") or "").strip().lower()
        request_id = str(request.get("id") or uuid.uuid4().hex)

        if request_type == "shutdown":
            emit({"type": "shutdown", "ok": True, "id": request_id})
            break

        if request_type == "health":
            emit({"type": "health", "ok": True, "id": request_id})
            continue

        if request_type != "synthesize":
            emit(
                {
                    "type": "result",
                    "ok": False,
                    "id": request_id,
                    "error": f"unsupported_request_type:{request_type or 'unknown'}",
                }
            )
            continue

        text = str(request.get("text") or "").strip()
        if not text:
            emit({"type": "result", "ok": False, "id": request_id, "error": "text_empty"})
            continue

        try:
            asyncio.run(synthesize_stream(genie, args.character, text, request_id))
            emit(
                {
                    "type": "result",
                    "ok": True,
                    "id": request_id,
                    "streamed": True,
                }
            )
        except Exception as error:
            emit(
                {
                    "type": "result",
                    "ok": False,
                    "id": request_id,
                    "error": str(error),
                    "traceback": traceback.format_exc(),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
