import UIKit
import XCTest

extension ArgentRunnerSession {
    /// `screenshot`: a full-screen capture as base64 PNG or JPEG, optionally
    /// downscaled with a CoreGraphics resample. This path touches no accessibility
    /// APIs, so it is the fallback observation channel when snapshots degrade.
    func captureScreenshot(_ params: RunnerParams) throws -> ScreenshotReply {
        let image = XCUIScreen.main.screenshot().image
        let scale = params.scale ?? 1.0
        let cg = try Self.resample(image, scale: scale)
        let uiImage = UIImage(cgImage: cg)

        let format = (params.format ?? "png").lowercased()
        let data: Data
        let mime: String
        if format == "jpeg" || format == "jpg" {
            let quality = CGFloat(params.quality ?? 80) / 100
            guard let jpeg = uiImage.jpegData(compressionQuality: max(0.01, min(1, quality))) else {
                throw RunnerError.failed("jpeg encode failed")
            }
            data = jpeg
            mime = "image/jpeg"
        } else {
            guard let png = uiImage.pngData() else {
                throw RunnerError.failed("png encode failed")
            }
            data = png
            mime = "image/png"
        }

        return ScreenshotReply(
            data: data.base64EncodedString(),
            mimeType: mime,
            width: cg.width,
            height: cg.height
        )
    }

    /// Downscales the image by `scale` (0 < scale < 1) with a CoreGraphics
    /// high-quality resample; returns the original bitmap for scale ≥ 1.
    private static func resample(_ image: UIImage, scale: Double) throws -> CGImage {
        guard let cg = image.cgImage else {
            throw RunnerError.failed("screenshot has no CGImage")
        }
        if scale >= 1.0 || scale <= 0 { return cg }

        let width = max(1, Int(Double(cg.width) * scale))
        let height = max(1, Int(Double(cg.height) * scale))
        let colorSpace = cg.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw RunnerError.failed("CGContext allocation failed")
        }
        context.interpolationQuality = .high
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let out = context.makeImage() else {
            throw RunnerError.failed("resample produced no image")
        }
        return out
    }
}
