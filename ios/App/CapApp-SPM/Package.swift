// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "DbeeOriginProxy", path: "../../../native-plugins/dbee-origin-proxy"),
        .package(name: "CapacitorShare", path: "../../../node_modules/@capacitor/share"),
        .package(name: "DbeeHealth", path: "../../../native-plugins/dbee-health"),
        .package(name: "DbeeIap", path: "../../../native-plugins/dbee-iap"),
        .package(name: "CapacitorCamera", path: "../../../node_modules/@capacitor/camera")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "DbeeOriginProxy", package: "DbeeOriginProxy"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "DbeeHealth", package: "DbeeHealth"),
                .product(name: "DbeeIap", package: "DbeeIap"),
                .product(name: "CapacitorCamera", package: "CapacitorCamera")
            ]
        )
    ]
)
