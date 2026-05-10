import SwiftUI

// Root: onboarding or the tabbed app, depending on whether we have any paired squads.
struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()
            if state.isOnboarded {
                MainTabsView()
                    .transition(.opacity)
            } else {
                OnboardingView { paired in
                    state.addPaired(paired)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: state.isOnboarded)
    }
}
