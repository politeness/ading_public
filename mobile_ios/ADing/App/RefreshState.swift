import Foundation

/// Each resource owns its error and accepts results only from its latest refresh.
struct RefreshState {
    enum Resource: CaseIterable { case friends, conversations, shares }
    private var requests: [Resource: UUID] = [:]
    private var errors: [Resource: String] = [:]

    var error: String? { Resource.allCases.compactMap { errors[$0] }.first }

    mutating func begin(_ resource: Resource) -> UUID {
        let request = UUID()
        requests[resource] = request
        return request
    }

    mutating func finish(_ resource: Resource, request: UUID, error: Error? = nil) -> Bool {
        guard requests[resource] == request else { return false }
        requests[resource] = nil
        if let error, RequestCancellation.isCancellation(error) { return false }
        errors[resource] = error?.localizedDescription
        return error == nil
    }

    mutating func reset() {
        requests.removeAll()
        errors.removeAll()
    }
}

/// Coalesces overlapping refreshes of one resource: while a run is in flight, further calls only
/// mark it dirty and wait; the run then repeats once, so bursts never starve the in-flight request.
@MainActor
final class CoalescedRefresh {
    private var running: Task<Void, Never>?
    private var dirty = false
    private var generation = 0

    /// Returns once a run that started after this call has finished (or the run was cancelled).
    func run(_ operation: @escaping @MainActor () async -> Void) async {
        if let running {
            dirty = true
            await running.value
            return
        }
        generation += 1
        let current = generation
        let task = Task { @MainActor in
            repeat {
                self.dirty = false
                await operation()
            } while self.dirty && self.generation == current && !Task.isCancelled
            // Checked and cleared without suspension, so no caller can mark a finished run dirty.
            if self.generation == current { self.running = nil }
        }
        running = task
        await task.value
    }

    /// Drops the in-flight run and any pending repeat (sign-out).
    func cancel() {
        generation += 1
        running?.cancel()
        running = nil
        dirty = false
    }
}
