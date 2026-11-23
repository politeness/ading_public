import Foundation

@main struct RefreshStateTests {
    static var checks = 0
    static func check(_ value: Bool, _ message: String, line: Int = #line) {
        checks += 1
        guard value else { fatalError("Line \(line): \(message)") }
    }

    @MainActor static func main() async {
        for cancellation in [CancellationError(), URLError(.cancelled),
                             NSError(domain: NSURLErrorDomain, code: -999)] as [Error] {
            check(RequestCancellation.isCancellation(cancellation), "typed cancellation")
            do {
                try RequestCancellation.check(cancellation)
                fatalError("Cancellation was not propagated")
            } catch {
                check(error is CancellationError, "transport retains cancellation semantics")
            }
            var state = RefreshState()
            let request = state.begin(.conversations)
            check(!state.finish(.conversations, request: request, error: cancellation), "do not publish cancelled data")
            check(state.error == nil, "cancellation is silent")
        }
        for failure in [URLError(.timedOut), URLError(.notConnectedToInternet),
                        NSError(domain: "OtherDomain", code: -999)] as [Error] {
            check(!RequestCancellation.isCancellation(failure), "real errors are not cancellation")
            do { try RequestCancellation.check(failure) } catch { fatalError("Suppressed real failure") }
        }

        let network = URLError(.notConnectedToInternet)
        let authentication = NSError(domain: "Authentication", code: 401,
                                     userInfo: [NSLocalizedDescriptionKey: "Sign in again"])
        var state = RefreshState()
        var request = state.begin(.conversations)
        check(!state.finish(.conversations, request: request, error: network), "show real network failure")
        check(state.error == network.localizedDescription, "network description preserved")
        request = state.begin(.conversations)
        check(!state.finish(.conversations, request: request, error: CancellationError()), "cancel retry")
        check(state.error == network.localizedDescription, "cancel does not claim recovery")
        request = state.begin(.conversations)
        check(state.finish(.conversations, request: request), "same-resource recovery")
        check(state.error == nil, "recovery clears stale error")

        let friends = state.begin(.friends)
        _ = state.finish(.friends, request: friends, error: authentication)
        request = state.begin(.conversations)
        _ = state.finish(.conversations, request: request)
        check(state.error == "Sign in again", "other-resource success preserves auth failure")
        request = state.begin(.friends)
        _ = state.finish(.friends, request: request)
        check(state.error == nil, "corresponding resource recovers")

        let older = state.begin(.conversations)
        let newer = state.begin(.conversations)
        check(state.finish(.conversations, request: newer), "newer success accepted")
        check(!state.finish(.conversations, request: older, error: network), "late old error ignored")
        check(state.error == nil, "old failure cannot resurrect banner")
        let oldSuccess = state.begin(.conversations)
        let newFailure = state.begin(.conversations)
        _ = state.finish(.conversations, request: newFailure, error: network)
        check(!state.finish(.conversations, request: oldSuccess), "old success cannot overwrite data")
        check(state.error == network.localizedDescription, "old success cannot clear newer failure")

        let oldRequest = state.begin(.conversations)
        let cancelledRequest = state.begin(.conversations)
        _ = state.finish(.conversations, request: cancelledRequest, error: URLError(.cancelled))
        check(!state.finish(.conversations, request: oldRequest), "cancelled latest request does not revive old result")
        let beforeSignOut = state.begin(.friends)
        state.reset()
        let afterSignIn = state.begin(.friends)
        check(!state.finish(.friends, request: beforeSignOut, error: authentication), "signed-out requests invalidated")
        check(state.error == nil, "sign-out clears error")
        check(state.finish(.friends, request: afterSignIn), "new sign-in works")
        await coalescing()
        print("RefreshStateTests: \(checks) checks passed")
    }

    /// Holds each refresh run open until released, so tests control when a request completes.
    @MainActor final class Runs {
        var started = 0
        var finished = 0
        private var waiting: [CheckedContinuation<Void, Never>] = []
        func operation() async {
            started += 1
            await withCheckedContinuation { waiting.append($0) }
            finished += 1
        }
        func release() { if !waiting.isEmpty { waiting.removeFirst().resume() } }
        func releaseAll() { while !waiting.isEmpty { release() } }
    }

    @MainActor static func settle() async { for _ in 0..<20 { await Task.yield() } }

    @MainActor static func coalescing() async {
        let refresh = CoalescedRefresh()
        let runs = Runs()
        var returned = 0
        let first = Task { @MainActor in await refresh.run(runs.operation); returned += 1 }
        await settle()
        check(runs.started == 1, "first call starts a request")
        // A burst of MESSAGE_NEW events while the request is in flight.
        let burst = (0..<10).map { _ in Task { @MainActor in await refresh.run(runs.operation); returned += 1 } }
        await settle()
        check(runs.started == 1, "burst does not start or invalidate requests")
        runs.release()
        await settle()
        check(runs.finished == 1, "in-flight request completes and publishes")
        check(runs.started == 2, "burst coalesces into exactly one follow-up")
        check(returned == 0, "callers wait for the follow-up that covers their change")
        runs.release()
        await first.value
        for task in burst { await task.value }
        check(runs.started == 2 && returned == 11, "all callers return after the follow-up")

        let later = Task { @MainActor in await refresh.run(runs.operation) }
        await settle()
        check(runs.started == 3, "call after completion starts a new request")
        runs.release()
        await later.value

        let signedOut = Task { @MainActor in await refresh.run(runs.operation) }
        await settle()
        _ = Task { @MainActor in await refresh.run(runs.operation) }
        await settle()
        refresh.cancel()
        let signedIn = Task { @MainActor in await refresh.run(runs.operation) }
        await settle()
        check(runs.started == 5, "after cancel a new call starts immediately")
        runs.releaseAll()
        await signedOut.value
        await signedIn.value
        await settle()
        check(runs.started == 5, "cancelled run does not repeat its pending follow-up")
    }
}
