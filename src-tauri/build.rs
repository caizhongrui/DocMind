fn main() {
    // macOS：显式链接 Vision 框架，确保 VNImageRequestHandler 等 ObjC 类在
    // `cargo test` 单元测试环境中也能被运行时找到。
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=Vision");
        println!("cargo:rustc-link-lib=framework=CoreImage");
        println!("cargo:rustc-link-lib=framework=CoreML");
    }

    tauri_build::build()
}
