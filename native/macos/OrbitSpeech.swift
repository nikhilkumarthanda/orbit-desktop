import AppKit
import AVFoundation
import CoreLocation
import Foundation
import Speech

final class OrbitSpeech: NSObject, SFSpeechRecognizerDelegate, NSSpeechRecognizerDelegate, CLLocationManagerDelegate {
    private let transcriber = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    private let engine = AVAudioEngine()
    private var wakeRecognizer: NSSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var capturingCommand = false
    private var suspended = false
    private var speaking = false
    private var followupMode = false
    private var generation = 0
    private var locationManager: CLLocationManager?
    private var wakeListeningActive = false
    private var wakeHeartbeatTimer: Timer?

    override init() {
        super.init()
        transcriber.delegate = self
        let wake = NSSpeechRecognizer()
        wake?.commands = ["Hey Orbit", "Orbit", "Stop", "Skip", "That's enough", "That is enough"]
        wake?.listensInForegroundOnly = false
        wake?.blocksOtherRecognizers = false
        wake?.delegate = self
        wakeRecognizer = wake
    }

    private func emit(_ type: String, _ payload: [String: Any] = [:]) {
        var event = payload
        event["type"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: event), let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }

    // Diagnostic-only trace for the idle wake-word pipeline. Sent as a "debug"
    // event over the same stdout JSON protocol so it shows up in Electron's
    // [speech] stdout log without touching any UI-visible voice state.
    private func trace(_ stage: String, _ payload: [String: Any] = [:]) {
        var event = payload
        event["stage"] = stage
        emit("debug", event)
    }

    func begin() {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { self.emit("error", ["message": "Speech Recognition permission was not granted"]); return }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else { self.emit("error", ["message": "Microphone permission was not granted"]); return }
                DispatchQueue.main.async { self.startWakeListening() }
            }
        }
    }

    private func startWakeListening() {
        guard !capturingCommand, !suspended else {
            trace("wake-armed-skipped", ["capturingCommand": capturingCommand, "suspended": suspended])
            return
        }
        wakeRecognizer?.startListening()
        wakeListeningActive = true
        trace("wake-armed", ["commands": wakeRecognizer?.commands ?? [], "message": "Wake-word listener armed, idle-listening for Hey Orbit"])
        emit("ready", ["onDevice": true, "mode": "wake-word"])
        startWakeHeartbeat()
    }

    // NSSpeechRecognizer (the legacy command-recognition API backing wake-word
    // detection) exposes no per-frame audio callback and no confidence score -
    // this heartbeat is the closest available signal that the idle listener is
    // still alive between wake attempts.
    private func startWakeHeartbeat() {
        wakeHeartbeatTimer?.invalidate()
        wakeHeartbeatTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.wakeListeningActive else { return }
            self.trace("wake-idle-heartbeat", ["message": "Still idle-listening for Hey Orbit"])
        }
    }

    func speechRecognizer(_ sender: NSSpeechRecognizer, didRecognizeCommand command: String) {
        let normalized = command.lowercased()
        trace("wake-word-detected", ["raw": command, "normalized": normalized, "speaking": speaking, "message": "NSSpeechRecognizer matched a registered command (this API exposes no confidence score)"])
        if speaking && ["stop", "skip", "that's enough", "that is enough"].contains(normalized) {
            emit("interrupt", ["message": "Speech interruption recognized"])
            speaking = false
            suspended = false
            return
        }
        if speaking {
            emit("interrupt", ["message": "New wake request recognized"])
            speaking = false
            suspended = false
        }
        activateCommandCapture()
    }

    func arm() {
        activateCommandCapture()
    }

    private func activateCommandCapture(followup: Bool = false) {
        guard !capturingCommand, !suspended else {
            trace("wake-event-skipped", ["capturingCommand": capturingCommand, "suspended": suspended, "followup": followup])
            return
        }
        followupMode = followup
        capturingCommand = true
        generation += 1
        wakeRecognizer?.stopListening()
        wakeListeningActive = false
        trace("wake-event-emit", ["followup": followup, "message": followup ? "Sending follow-up event to Electron" : "Sending wake event to Electron"])
        emit(followup ? "listening" : "wake", ["mode": "command", "message": followup ? "Listening for a follow-up" : "Wake phrase recognized"])
        // The wake acknowledgement is deliberately short. Begin capturing quickly
        // while still leaving enough time to avoid transcribing Orbit's own voice.
        DispatchQueue.main.asyncAfter(deadline: .now() + (followup ? 0.18 : 0.55)) { [weak self] in
            guard let self, self.capturingCommand, !self.suspended else { return }
            self.startCommandRecognition()
        }
    }

    private func startCommandRecognition() {
        stopTranscription()
        request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else { failAndResume("Unable to create speech request"); return }
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        request.taskHint = .dictation

        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else { failAndResume("No microphone input is available"); return }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        engine.prepare()
        do { try engine.start() } catch { failAndResume(error.localizedDescription); return }
        emit("listening", ["message": "Command capture active"])

        task = transcriber.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result { self.consumeCommand(result.bestTranscription.formattedString, final: result.isFinal) }
            if let error, self.capturingCommand { self.emit("error", ["message": error.localizedDescription]); self.resumeWakeListening() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (followupMode ? 30 : 25)) { [weak self] in
            guard let self, self.capturingCommand else { return }
            if !self.followupMode { self.emit("error", ["message": "I did not hear a command. Try again, boss."]) }
            self.resumeWakeListening()
        }
    }

    private func consumeCommand(_ transcript: String, final: Bool) {
        let command = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { return }
        generation += 1
        let current = generation
        emit("partial", ["text": command])
        // Natural sentences often contain short thinking pauses. Wait long enough
        // for the transcription to continue instead of submitting a fragment.
        let endsInFiller = command.range(of: #"\b(?:um+|uh+|erm+|hmm+|like|so|and|but)$"#, options: [.regularExpression, .caseInsensitive]) != nil
        let settlingDelay = endsInFiller ? 5.0 : (final ? 3.0 : 3.8)
        DispatchQueue.main.asyncAfter(deadline: .now() + settlingDelay) { [weak self] in
            guard let self, self.capturingCommand, current == self.generation else { return }
            self.emit("command", ["text": command])
            self.resumeWakeListening()
        }
    }

    private func stopTranscription() {
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    private func resumeWakeListening() {
        capturingCommand = false
        followupMode = false
        stopTranscription()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.startWakeListening() }
    }

    func pause() {
        suspended = true
        speaking = true
        wakeRecognizer?.stopListening()
        if capturingCommand {
            capturingCommand = false
            stopTranscription()
        }
        wakeRecognizer?.startListening()
    }

    func resume() {
        wakeRecognizer?.stopListening()
        speaking = false
        suspended = false
        startWakeListening()
    }

    func followup() {
        wakeRecognizer?.stopListening()
        speaking = false
        suspended = false
        activateCommandCapture(followup: true)
    }

    func requestLocation() {
        let manager = locationManager ?? CLLocationManager()
        locationManager = manager
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            emit("locationError", ["message": "Location permission is off. Enable Orbit in System Settings, Privacy and Security, Location Services."])
        } else { manager.requestLocation() }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedAlways {
            manager.requestLocation()
        }
        else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            emit("locationError", ["message": "Location permission was not granted"])
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        emit("location", ["latitude": location.coordinate.latitude, "longitude": location.coordinate.longitude])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        emit("locationError", ["message": error.localizedDescription])
    }

    private func failAndResume(_ message: String) {
        emit("error", ["message": message])
        resumeWakeListening()
    }
}

let orbit = OrbitSpeech()
orbit.begin()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "arm": DispatchQueue.main.async { orbit.arm() }
        case "pause": DispatchQueue.main.async { orbit.pause() }
        case "resume": DispatchQueue.main.async { orbit.resume() }
        case "followup": DispatchQueue.main.async { orbit.followup() }
        case "location": DispatchQueue.main.async { orbit.requestLocation() }
        default: break
        }
    }
}
RunLoop.main.run()
