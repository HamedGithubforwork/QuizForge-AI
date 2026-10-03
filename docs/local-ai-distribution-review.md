# Local AI licensing and distribution review

Status: **engineering review complete; public distribution not approved yet**.

This document records the release constraints for the pinned Windows Local AI
candidate. It is an engineering compliance checklist, not legal advice.

## Pinned components

The runtime candidate is llama.cpp **b11317**, verified by archive SHA-256
`f3b2175f0fc3a7fb1bf53b1eddfeb6fd7a6c34761fec41cb293f6d70ba16288c`.
The upstream b11317 source license is MIT. The same source tree separately carries
the nlohmann/json MIT notice under `licenses/LICENSE-jsonhpp`.

The Windows CPU archive also contains `libomp.dll` and
`LICENSE-LLVM-OpenMP`. Upstream llama.cpp's build logic explicitly copies the
OpenMP runtime and its license into Windows runtime output. A distributable Quiz
From Notes runtime payload must preserve that notice.

The model candidate is Qwen/Qwen3-4B-GGUF revision
`bc640142c66e1fdd12af0bd68f40445458f3869b`, file
`Qwen3-4B-Q4_K_M.gguf`, SHA-256
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
The pinned revision contains the Apache License 2.0.

## Distribution decision

**Runtime executable code:** project policy is **bundle before activation**.
Do not add a post-install runtime executable downloader. The current verified
archive contains many CLI/benchmark executables the product does not use. The
current internal-preview candidate stages a 25-file server-only payload: the
server/runtime libraries, all x64 CPU-dispatch variants needed for compatibility,
and the three required notices. CLI, benchmark, quantization and RPC executables
are excluded. This remains an internal preview payload until the real Windows
packaging gate passes.

Any bundled runtime payload must include the applicable llama.cpp MIT notice,
the nlohmann/json MIT notice, and the LLVM OpenMP notice. The notices must be
included in the installed product's third-party notices surface/package and must
be verified in packaging CI.

**Model weights:** keep them outside the installer and download only after explicit
user action. They are model data, not executable runtime code. The existing model
store pins revision, size and SHA-256, requires HTTPS/approved Hugging Face storage
hosts, and never silently downloads. The Local AI settings surface must identify
the model and Apache-2.0 license before public activation.

## Microsoft Store constraint

The current Microsoft Store policy (reviewed 2026-10-03, policy version 7.20)
prohibits dynamic inclusion of code that fundamentally changes or extends the
described product in violation of Store policies. For non-gaming products
submitted using an HTTPS installer URL, Microsoft also requires the installer to
be standalone rather than a downloader stub, and requires the installer and its
PE files to satisfy the Store's signing requirements.

Because the local runtime is native executable code, Quiz From Notes will not
depend on a runtime executable downloaded after install unless a later,
channel-specific Store review explicitly approves that design. Bundling the
reviewed runtime is the conservative common path for Store/direct packages.
The model remains a separately downloaded data asset.

The existing Store build can rely on Microsoft Store package signing after
acceptance. Direct-distribution signing or any paid certificate/service remains an
owner-approval item and must not be purchased automatically.

## Remaining release blockers

1. Validate the staged 25-file server-only runtime payload on real Windows,
   including the full CPU-dispatch set and packaged-resource re-verification.
2. Verify the llama.cpp, nlohmann/json and LLVM OpenMP notices byte-for-byte in
   the staged and packaged runtime payload.
3. Add a user-visible model identity/license disclosure before model download.
4. Complete the broader product quality/performance acceptance gate.
5. Keep the desktop moderate/high dependency audit green; do not replace an audit failure with an exception or severity downgrade.
6. Choose/approve the actual signing and distribution channel. No paid signing
   service or certificate may be purchased without owner approval.
7. Only after these pass may a preview release candidate bundle a runtime and make
   Local AI generation visible on compatible hardware.

## Sources reviewed

- llama.cpp b11317 source LICENSE:
  https://github.com/ggml-org/llama.cpp/blob/b11317/LICENSE
- llama.cpp b11317 nlohmann/json notice:
  https://github.com/ggml-org/llama.cpp/blob/b11317/licenses/LICENSE-jsonhpp
- llama.cpp OpenMP packaging logic:
  https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/CMakeLists.txt
- Qwen3-4B-GGUF pinned revision license:
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/blame/bc640142c66e1fdd12af0bd68f40445458f3869b/LICENSE
- Current Microsoft Store policies:
  https://learn.microsoft.com/windows/apps/publish/store-policies
