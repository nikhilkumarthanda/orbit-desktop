import AVFoundation
import Foundation
import Speech

final class OrbitSpeech: NSObject, SFSpeechRecognizerDelegate {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var armed = false
    private var generation = 0
    private let wakePhrases = ["hey orbit", "hay orbit", "hey orbid", "hey or bit"]

    override init() {
        super.init()
        recognizer.delegate = self
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
            guard status == .authorized else { self.emit("error", ["message": "Speech recognition permission was not granted"]); return }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else { self.emit("error", ["message": "Microphone permission was not granted"]); return }
                DispatchQueue.main.async { self.startRecognition() }
            }
        }
    }

    func arm() {
        armed = true
        emit("wake")
    }

    private func startRecognition() {
        task?.cancel()
        task = nil
        request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else { emit("error", ["message": "Unable to create speech request"]); return }
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do { try engine.start() } catch { emit("error", ["message": error.localizedDescription]); return }
        emit("ready", ["onDevice": request.requiresOnDeviceRecognition])
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result { self.consume(result.bestTranscription.formattedString, final: result.isFinal) }
            if error != nil || result?.isFinal == true { self.restartSoon() }
        }
    }

    private func consume(_ transcript: String, final: Bool) {
        let normalized = transcript.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        var command = ""
        if let phrase = wakePhrases.first(where: { normalized.contains($0) }),
           let range = normalized.range(of: phrase) {
            if !armed { armed = true; emit("wake") }
            command = String(normalized[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if armed { command = normalized.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !command.isEmpty else { return }
        generation += 1
        let current = generation
        emit("partial", ["text": command])
        DispatchQueue.main.asyncAfter(deadline: .now() + (final ? 0.1 : 1.1)) {
            guard current == self.generation, self.armed else { return }
            self.armed = false
            self.emit("command", ["text": command])
            self.restartSoon()
        }
    }

    private func restartSoon() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.startRecognition() }
    }
}

let orbit = OrbitSpeech()
orbit.begin()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespacesAndNewlines) == "arm" {
            DispatchQueue.main.async { orbit.arm() }
        }
    }
}
RunLoop.main.run()
