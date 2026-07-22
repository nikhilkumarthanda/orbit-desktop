import AppKit
import AVFoundation
import Foundation
import Speech

final class OrbitSpeech: NSObject, SFSpeechRecognizerDelegate, NSSpeechRecognizerDelegate {
    private let transcriber = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    private let engine = AVAudioEngine()
    private var wakeRecognizer: NSSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var capturingCommand = false
    private var suspended = false
    private var followupMode = false
    private var generation = 0

    override init() {
        super.init()
        transcriber.delegate = self
        let wake = NSSpeechRecognizer()
        wake?.commands = ["Hey Orbit", "Orbit"]
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
        guard !capturingCommand, !suspended else { return }
        wakeRecognizer?.startListening()
        emit("ready", ["onDevice": true, "mode": "wake-word"])
    }

    func speechRecognizer(_ sender: NSSpeechRecognizer, didRecognizeCommand command: String) {
        activateCommandCapture()
    }

    func arm() {
        activateCommandCapture()
    }

    private func activateCommandCapture(followup: Bool = false) {
        guard !capturingCommand, !suspended else { return }
        followupMode = followup
        capturingCommand = true
        generation += 1
        wakeRecognizer?.stopListening()
        emit(followup ? "listening" : "wake", ["mode": "command", "message": followup ? "Listening for a follow-up" : "Wake phrase recognized"])
        // Leave room for Orbit's spoken acknowledgement so it never hears itself.
        DispatchQueue.main.asyncAfter(deadline: .now() + (followup ? 0.25 : 1.15)) { [weak self] in
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
        DispatchQueue.main.asyncAfter(deadline: .now() + (followupMode ? 20 : 12)) { [weak self] in
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
        DispatchQueue.main.asyncAfter(deadline: .now() + (final ? 0.1 : 0.9)) { [weak self] in
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
        wakeRecognizer?.stopListening()
        if capturingCommand {
            capturingCommand = false
            stopTranscription()
        }
    }

    func resume() {
        suspended = false
        startWakeListening()
    }

    func followup() {
        suspended = false
        activateCommandCapture(followup: true)
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
        default: break
        }
    }
}
RunLoop.main.run()
