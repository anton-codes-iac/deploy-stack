# 🩹 Hotfix: Destroy Command Crash

This patch resolves a critical bug in the telemetry payload of the `deploy-stack destroy` command introduced in `v0.14.0`. 

**Bug Fix:**
* Fixed a JavaScript block-scoping `ReferenceError` that caused the CLI to crash immediately after deleting the S3 state bucket, preventing the final success message and telemetry event from firing. Teardowns will now exit gracefully.