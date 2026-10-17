// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DbeeHealth",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "DbeeHealth",
            targets: ["DbeeHealth"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "DbeeHealth",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/DbeeHealth")
    ]
)
