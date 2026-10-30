fn main() {
    // `start` is an app command; listing it in the manifest lets a capability grant it to the local start page
    // only, so the remote Forewright page cannot call it.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["start"])),
    )
    .expect("failed to run the Tauri build script");
}
