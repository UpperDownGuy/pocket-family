import UIKit
import UserNotifications

@MainActor
final class PushManager: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var tokenHandler: ((String) -> Void)?
    var refreshHandler: (() -> Void)?
    var registrationErrorHandler: ((String) -> Void)?
    private(set) var lastDeviceToken: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                application.registerForRemoteNotifications()
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastDeviceToken = token
        tokenHandler?(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        registrationErrorHandler?("Push registration failed. Check signing and the Push Notifications capability in Xcode.")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The server sends only a generic alert. Details always come from the authenticated inbox.
        Task { @MainActor in self.refreshHandler?() }
        completionHandler([])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in self.refreshHandler?() }
        completionHandler()
    }
}
