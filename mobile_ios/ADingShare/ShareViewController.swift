import SwiftUI
import UIKit

/// Share extension entry point (Info.plist's NSExtensionPrincipalClass). The UI is written in SwiftUI; this only mounts it.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model).environment(\.locale, AppLanguage.saved.locale))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}
