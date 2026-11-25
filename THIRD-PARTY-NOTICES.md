# Third-party notices

Stephen itself is MIT licensed. See [LICENSE](LICENSE).

This file lists the third-party code and models that Stephen uses at runtime. It covers the npm packages that ship with the app, the Apple frameworks the Swift helper links, and the voice models that are downloaded on first run.

## npm runtime packages

The table lists every package that `npm ci --omit=dev` installs. It was generated from `package-lock.json` at commit `01e19f0` (the tip of `origin/qa` when this was written). A package can appear more than once when npm keeps a second copy under another package.

Every package in the lockfile has a license field, so no license is marked unknown.

### Count per license

| License | Packages |
|---|---|
| MIT | 100 |
| Apache-2.0 | 12 |
| ISC | 11 |
| BSD-3-Clause | 3 |
| BSD-2-Clause | 1 |
| **Total** | **127** |

### Packages

| Package | Version | License |
|---|---|---|
| @hono/node-server | 2.1.5 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| @picovoice/pvrecorder-node | 1.2.9 | Apache-2.0 |
| @puppeteer/browsers | 3.2.6 | Apache-2.0 |
| accepts | 2.0.0 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| ansi-regex | 6.5.0 | MIT |
| ansi-styles | 6.2.3 | MIT |
| body-parser | 2.4.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| chromium-bidi | 157.0.8090-0 | Apache-2.0 |
| cliui | 9.0.1 | ISC |
| content-disposition | 2.0.1 | MIT |
| content-type | 1.0.5 | MIT |
| content-type | 2.1.0 | MIT |
| content-type | 2.1.0 | MIT |
| content-type | 2.1.0 | MIT |
| content-type | 2.1.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cors | 2.8.6 | MIT |
| cross-spawn | 7.0.6 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| devtools-protocol | 0.0.1704951 | BSD-3-Clause |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| emoji-regex | 10.6.0 | MIT |
| encodeurl | 2.0.1 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| escalade | 3.2.0 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.1.1 | MIT |
| express | 5.3.0 | MIT |
| express-rate-limit | 8.7.2 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-caller-file | 2.0.5 | ISC |
| get-east-asian-width | 1.7.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| hono | 4.13.14 | MIT |
| http-errors | 2.0.1 | MIT |
| iconv-lite | 0.7.3 | MIT |
| inherits | 2.0.4 | ISC |
| ip-address | 10.7.5 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| isexe | 2.0.0 | ISC |
| jose | 6.2.14 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-schema-typed | 8.0.2 | BSD-2-Clause |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 1.1.1 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 3.0.2 | MIT |
| mitt | 3.0.1 | MIT |
| modern-tar | 0.8.6 | MIT |
| ms | 2.1.3 | MIT |
| negotiator | 1.1.0 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| on-finished | 2.4.2 | MIT |
| once | 1.4.0 | ISC |
| parseurl | 1.3.3 | MIT |
| path-key | 3.1.1 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| proxy-addr | 2.0.8 | MIT |
| puppeteer-core | 25.16.0 | Apache-2.0 |
| qs | 6.17.1 | BSD-3-Clause |
| range-parser | 1.3.0 | MIT |
| raw-body | 3.0.2 | MIT |
| require-from-string | 2.0.2 | MIT |
| router | 2.2.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| sherpa-onnx-darwin-arm64 | 1.13.8 | Apache-2.0 |
| sherpa-onnx-darwin-x64 | 1.13.8 | Apache-2.0 |
| sherpa-onnx-linux-arm64 | 1.13.8 | Apache-2.0 |
| sherpa-onnx-linux-x64 | 1.13.8 | Apache-2.0 |
| sherpa-onnx-node | 1.13.8 | Apache-2.0 |
| sherpa-onnx-win-ia32 | 1.13.8 | Apache-2.0 |
| sherpa-onnx-win-x64 | 1.13.8 | Apache-2.0 |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| string-width | 7.2.0 | MIT |
| string-width | 7.2.0 | MIT |
| string-width | 8.3.0 | MIT |
| strip-ansi | 7.2.0 | MIT |
| toidentifier | 1.0.1 | MIT |
| type-is | 2.1.0 | MIT |
| typed-query-selector | 2.12.3 | MIT |
| unpipe | 1.0.0 | MIT |
| vary | 1.1.2 | MIT |
| webdriver-bidi-protocol | 1.0.1 | Apache-2.0 |
| which | 2.0.2 | ISC |
| wrap-ansi | 9.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| ws | 8.22.0 | MIT |
| y18n | 5.0.8 | ISC |
| yargs | 18.2.0 | MIT |
| yargs-parser | 22.0.0 | ISC |
| zod | 4.6.7 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |

To regenerate the list, run this from the repo root. It prints one line per package: path, version, license.

```sh
node -e 'const l=require("./package-lock.json");for(const[k,v]of Object.entries(l.packages)){if(!k||v.dev)continue;console.log(k.replace(/^.*node_modules\//,""),v.version,v.license)}'
```

Copyleft check: no GPL, LGPL, AGPL, MPL or CC-BY-SA license is in this list.

Attribution: MIT, ISC, BSD and Apache-2.0 packages ask that their copyright notice and license text stay with the code. Apache-2.0 packages also ask that any NOTICE file stays with the code. Before a public release, the app bundle must carry these texts.

## Swift helper

The Swift helper in `helper/` has no Swift package and no third-party dependency. It links only Apple frameworks that ship with macOS: AppKit, CoreAudio, CoreGraphics and SwiftUI (`HELPER_FRAMEWORKS` in `src/helper/install.ts`). No notice is needed for these.

## Downloaded voice models

These models are not in the repo. The app downloads each one on first run, checks its sha256, and keeps only the files it needs. The model ids, sources and licenses come from `src/voice/models.ts` and `src/voice/tts/kokoro.ts`. The license column is the value written in the code. Before a public release, check each license against the upstream model card (P4).

| Model id | Use | Source (github.com/k2-fsa/sherpa-onnx releases unless noted) | License (as written in the code) |
|---|---|---|---|
| kws-gigaspeech-3.3M | Keyword spotting (wake word) | `kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2` | Apache-2.0 |
| silero-vad | Voice activity detection | `asr-models/silero_vad.onnx` | MIT |
| parakeet-tdt-0.6b-v2 | Speech to text | `asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` | CC-BY-4.0 (needs attribution) |
| whisper-tiny.en | Speech to text | `asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2` | MIT |
| whisper-base.en | Speech to text | `asr-models/sherpa-onnx-whisper-base.en.tar.bz2` | MIT |
| whisper-small.en | Speech to text | `asr-models/sherpa-onnx-whisper-small.en.tar.bz2` | MIT |
| moonshine-tiny | Speech to text | `asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2` | MIT |
| moonshine-base | Speech to text | `asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2` | MIT |
| moonshine-base-v2 | Speech to text | `asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2` | MIT |
| kokoro-int8-en-v0_19 | Text to speech | `tts-models/kokoro-int8-en-v0_19.tar.bz2` | Apache-2.0 |

The parakeet model is marked CC-BY-4.0. That license needs credit to the model authors in the app and in this file.
