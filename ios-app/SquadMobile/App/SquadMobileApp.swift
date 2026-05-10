import SwiftUI

@main
struct SquadMobileApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .preferredColorScheme(.dark)
                .tint(Tokens.accent)
                .onAppear {
                    if state.isOnboarded { state.connectActive() }
                }
        }
    }
}
