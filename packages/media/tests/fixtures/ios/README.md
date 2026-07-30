# UIKit media fixtures

These 2 x 2 fixtures were produced on an iOS simulator with UIKit, not by a generic image encoder.

## Regeneration

1. Create a small source image and run this program against the simulator SDK:

   ```swift
   import Foundation
   import UIKit

   let arguments = CommandLine.arguments
   let source = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
   guard
     let image = UIImage(data: source),
     let png = image.pngData(),
     let jpeg = image.jpegData(compressionQuality: 1.0)
   else {
     fatalError("UIKit could not encode the source image")
   }
   try png.write(to: URL(fileURLWithPath: arguments[2]))
   try jpeg.write(to: URL(fileURLWithPath: arguments[3]))
   ```

   Compile and run it with the active Xcode toolchain:

   ```sh
   SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
   xcrun --sdk iphonesimulator swiftc \
     -sdk "$SDK_PATH" \
     -target arm64-apple-ios16.0-simulator \
     reencode.swift -o reencode
   xcrun simctl spawn booted ./reencode \
     source.png uikit-encoded.png uikit-encoded.jpg
   ```

2. Copy the encoded files into this fixture directory:

   ```sh
   cp uikit-encoded.png packages/media/tests/fixtures/ios/
   cp uikit-encoded.jpg packages/media/tests/fixtures/ios/
   ```

3. Run the current Expo/iOS sanitizer against both encoded inputs and copy its
   outputs here as `uikit-sanitized.png` and `uikit-sanitized.jpg`.
4. Run `pnpm --filter @buzz/media check` to verify that UIKit's encoded output
   is rejected and the matching sanitizer output is accepted by the TypeScript
   relay contract.

Regenerate both encoded and sanitized pairs whenever UIKit encoding or `MediaSanitizer` changes. Do not update only the sanitized files, because the test is intended to cover the exact encoder-to-sanitizer boundary.
