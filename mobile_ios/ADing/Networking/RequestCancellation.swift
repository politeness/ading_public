import Foundation

enum RequestCancellation {
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let error = error as NSError
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
    }

    /// Keep cancellation typed so callers can distinguish it from a failed request.
    static func check(_ error: Error) throws {
        if isCancellation(error) { throw CancellationError() }
    }
}
