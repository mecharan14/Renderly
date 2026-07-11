use super::{PreviewBounds, PreviewError};

#[derive(Clone, Copy)]
pub struct NativeWindow {
    pub _hwnd: isize,
}

pub struct PlatformPreview;

impl PlatformPreview {
    pub fn new() -> Self {
        Self
    }

    pub fn attach_parent(&mut self, _parent: NativeWindow) {}

    pub fn set_bounds(&mut self, _bounds: PreviewBounds) -> Result<(), PreviewError> {
        Err(PreviewError::Unsupported)
    }

    pub fn present_rgba(
        &mut self,
        _pixels: &[u8],
        _width: u32,
        _height: u32,
    ) -> Result<(), PreviewError> {
        Err(PreviewError::Unsupported)
    }

    pub fn shared_device(
        &self,
    ) -> Option<(std::sync::Arc<wgpu::Device>, std::sync::Arc<wgpu::Queue>)> {
        None
    }

    pub fn present_texture_view(
        &mut self,
        _source: &wgpu::TextureView,
    ) -> Result<(), PreviewError> {
        Err(PreviewError::Unsupported)
    }
}
