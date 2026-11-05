# Lantern

A small web chat for a local [vLLM](https://docs.vllm.ai) server, or any other server with an OpenAI-compatible API.
It is one ASP.NET Core binary, compiled with Native AOT, with the UI inside it.

- Streamed replies with Markdown (tables, code blocks with a copy button, lists, quotes).
- A collapsible thinking panel for reasoning models.
- Attach text files and images: use the paperclip, drag and drop, or paste.
- Large text files (logs, CSV) that do not fit the context: the model searches and reads them with tools,
  or you cut them to the newest lines that fit. See [Large files](#large-files).
- Model picker, system prompt, temperature, and max tokens.
- Token count, tokens per second, and time to first token for each reply.
- Stop and regenerate.
- Chat history stays in the browser (IndexedDB). The server keeps no state.

It is for one user on a LAN. It has no login.

## Run with Docker

```bash
docker run -d --name lantern -p 7319:7319 \
  -e VLLM_URL=http://<vllm-host>:8000/v1 \
  --restart unless-stopped \
  ghcr.io/d3mnjx/lantern:latest
```

Then open `http://<docker-host>:7319`. Images exist for `linux/amd64` and `linux/arm64`.

With Docker Compose, copy `.env.example` to `.env`, set `VLLM_URL`, and run `docker compose up -d`.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `VLLM_URL` | yes | Base URL of the OpenAI-compatible API, including `/v1`. |
| `VLLM_API_KEY` | no | Sent as a Bearer token, for a vLLM started with `--api-key`. |
| `ASPNETCORE_HTTP_PORTS` | no | Listen port. The default is `7319`. |

## Build from source

Needs the .NET 10 SDK and the [Native AOT prerequisites](https://learn.microsoft.com/dotnet/core/deploying/native-aot/#prerequisites) (clang).

```bash
dotnet publish -c Release -o publish
VLLM_URL=http://<vllm-host>:8000/v1 ./publish/lantern
```

It listens on `0.0.0.0:7319`. The output is one self-contained file, `publish/lantern`, of about 12 MB.

## How it works

- `Program.cs` serves the files in `web/` from embedded resources and forwards three routes:
  `GET /api/models`, `POST /api/chat`, and `POST /api/tokenize`. It passes the bytes through without parsing them,
  so the server code does not depend on the vLLM request schema.
- `web/app.js` builds OpenAI-style chat requests and reads the SSE stream.
  Text files go into the user message as fenced blocks. Images go as `image_url` parts (base64),
  so they need a vision model.
- `web/filetools.js` holds the file tools for tool mode and runs them in the browser.
- `web/markdown.js` is a small Markdown renderer. It escapes all input before it adds tags.
  The project has no third-party libraries.

## Large files

Lantern counts the tokens of each text file with the vLLM `/tokenize` endpoint when you attach it.
A guess from the file size is not safe: logs full of digits are about 1.3 characters per token, prose about 4.

A file that fits goes into the prompt. A file that does not fit goes to **tool mode**:

- The prompt gets only the file name, its size, and its first 5 lines.
- The model gets two tools: `read_lines` (a line range, or the last lines) and `grep`
  (a regex search with a match count, or with `count_by_group` a count per captured value).
- The browser runs the tools on the file. Only the results go to the model.
  Each tool call shows as one line in the reply. Click it to see the exact result.

Tool mode needs vLLM with tool calling on (`--enable-auto-tool-choice --tool-call-parser <parser>`).

The other choice is **Keep newest lines** on the file chip. It cuts the file to the newest lines that fit,
keeps the header line of a CSV or TSV file, and tells the model that the file is partial.

## Limits

- No PDF or Office files. Only text files (up to 10 MB) and images (up to 20 MB).
- Files above 2 MB get an estimated token count (2 characters per token) instead of an exact one.
- The page uses plain HTTP. Do not expose it to the internet.
