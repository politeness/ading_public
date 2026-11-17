import Foundation
import CocoaMQTT

/// Foreground-only MQTT. Every reconnect restores subscriptions and fetches durable data again.
@MainActor
final class MqttConnection {
    var onFrame: ((MqttFrame) -> Void)?
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onModeChanged: ((Bool) -> Void)?
    private var client: CocoaMQTT?
    private var work: Task<Void, Never>?
    private var renewal: Task<Void, Never>?
    private var running = false
    private var generation = 0
    private var attempts = 0
    private var deviceName = ""

    func start(deviceName: String) {
        guard !running else { return }
        running = true
        self.deviceName = deviceName
        connect()
    }
    func stop() {
        running = false
        generation += 1
        work?.cancel(); work = nil
        renewal?.cancel(); renewal = nil
        let old = client; client = nil
        old?.disconnect()
        onDisconnected?()
    }
    private func connect() {
        guard running else { return }
        generation += 1
        let current = generation
        work = Task { [weak self] in
            guard let self else { return }
            do {
                let credentials = try await APIClient.shared.mqttCredentials(deviceName: self.deviceName, appVersion: AppVersion.display)
                guard !Task.isCancelled, self.running, self.generation == current else { return }
                self.onModeChanged?(credentials.enabled)
                // When the server has MQTT off, use REST and ask again after a while, so it can switch over once enabled without waiting for a foreground/background switch
                guard credentials.enabled else {
                    self.retry(after: AppRules.mqttDisabledRecheckSeconds)
                    return
                }
                guard let address = credentials.brokerUrl, let url = URL(string: address),
                      url.scheme == "mqtts", let host = url.host,
                      let clientID = credentials.clientId, let username = credentials.username,
                      let password = credentials.password, !credentials.subscriptions.isEmpty,
                      credentials.expiresAt > Date().timeIntervalSince1970 * 1000,
                      let port = UInt16(exactly: url.port ?? 8883) else {
                    throw APIError.network("Invalid MQTT credentials")
                }
                let mqtt = CocoaMQTT(clientID: clientID, host: host, port: port)
                mqtt.username = username; mqtt.password = password
                mqtt.enableSSL = true; mqtt.allowUntrustCACertificate = false
                mqtt.cleanSession = true; mqtt.autoReconnect = false
                mqtt.keepAlive = UInt16(clamping: credentials.keepAliveSeconds)
                mqtt.didConnectAck = { [weak self] mqtt, ack in
                    Task { @MainActor in
                        guard let self, self.client === mqtt, self.generation == current else { return }
                        guard ack == .accept else { self.failed(mqtt); return }
                        mqtt.subscribe(credentials.subscriptions.map { ($0, CocoaMQTTQoS.qos1) })
                    }
                }
                mqtt.didSubscribeTopics = { [weak self] mqtt, success, failed in
                    Task { @MainActor in
                        guard let self, self.client === mqtt, self.generation == current else { return }
                        guard failed.isEmpty, Set(success.allKeys.compactMap { $0 as? String }) == Set(credentials.subscriptions) else {
                            self.failed(mqtt); return
                        }
                        self.attempts = 0
                        self.onConnected?()
                        self.renewal?.cancel()
                        self.renewal = Task { [weak self] in
                            let delay = max(1, credentials.expiresAt / 1000 - Date().timeIntervalSince1970 - 90)
                            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                            guard let self, self.client === mqtt else { return }
                            self.failed(mqtt, immediate: true)
                        }
                    }
                }
                mqtt.didReceiveMessage = { [weak self] mqtt, message, _ in
                    Task { @MainActor in
                        guard let self, self.client === mqtt, self.generation == current,
                              credentials.subscriptions.contains(message.topic),
                              let frame = try? JSONDecoder().decode(MqttFrame.self, from: Data(message.payload)) else { return }
                        self.onFrame?(frame)
                    }
                }
                mqtt.didDisconnect = { [weak self] mqtt, _ in
                    Task { @MainActor in self?.failed(mqtt) }
                }
                self.client = mqtt
                if !mqtt.connect(timeout: 15) { self.failed(mqtt) }
            } catch {
                guard !Task.isCancelled, self.running, self.generation == current else { return }
                self.retry()
            }
        }
    }
    private func failed(_ mqtt: CocoaMQTT, immediate: Bool = false) {
        guard client === mqtt else { return }
        client = nil
        renewal?.cancel(); renewal = nil
        mqtt.disconnect()
        onDisconnected?()
        retry(immediate: immediate)
    }
    private func retry(immediate: Bool = false) {
        guard running else { return }
        let delay = immediate ? 0 : AppRules.mqttRetryDelay(attempts: attempts)
        attempts += 1
        retry(after: delay)
    }
    private func retry(after delay: Double) {
        guard running else { return }
        work = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            self?.connect()
        }
    }
}
