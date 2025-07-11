import {
    Room,
    RemoteTrack,
    Track,
    createLocalAudioTrack,
    createLocalVideoTrack,
    RoomOptions,
    TrackPublication,
    RemoteParticipant,
    ConnectionState,
  } from "livekit-client";
  
  import {
    RTVIClientOptions,
    RTVIMessage,
    Tracks,
    Transport,
    TransportState,
  } from "@pipecat-ai/client-js";

  
  export interface LiveKitTransportAuthBundle {
    room_url: string;
    token: string;
  }

  export interface LiveKitTracks {
    audioTrack?: MediaStreamTrack;
    videoTrack?: MediaStreamTrack;
  }
  
  
  export interface LiveKitTransportConstructorOptions {
    bufferLocalAudioUntilBotReady?: boolean;
    roomOptions?: RoomOptions;
  }
  
  export enum LiveKitRTVIMessageType {
    AUDIO_BUFFERING_STARTED = "audio-buffering-started",
    AUDIO_BUFFERING_STOPPED = "audio-buffering-stopped"
  }
  
  export class LiveKitTransport extends Transport {
    private room: Room;
    public _state: TransportState = "disconnected";
    private _bufferAudio: boolean = false;
    private _audioBuffer: ArrayBuffer[] = [];
    private _messageHandler: (ev: RTVIMessage) => void = () => {};
  
    constructor(private options?: LiveKitTransportConstructorOptions) {
      super();
      this.room = new Room(this.options?.roomOptions);
    }
  
    get state(): TransportState {
      return this._state;
    }
  
    private set state(val: TransportState) {
      this._state = val;
    }

    private _emitInternalMessage(type: LiveKitRTVIMessageType): void {
        this._messageHandler({
          id: `${type}-${Date.now()}`,
          label: "internal",
          type,
          data: {},
        });
      }
  
      async connect(auth: LiveKitTransportAuthBundle, abortController: AbortController): Promise<void> {
        console.debug("Room URL:", auth.room_url);
        console.debug("Token:", auth.token);
      
        if (abortController.signal.aborted) return;
      
        this.state = "connecting";
      
        try {
          await this.room.connect(auth.room_url, auth.token);
          this.state = "connected";
        } catch (err) {
          console.error("LiveKit connection failed:", err);
          this.state = "disconnected";
          return;
        }
      
        console.log("LiveKit room connected");
      
        // Publish mic track right after connect
        try {
          const audioTrack = await createLocalAudioTrack({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          });
          await this.room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.Microphone,
            name: 'microphone'
          });
          console.log("Microphone track published successfully");
        } catch (err) {
          console.error("Failed to create or publish mic track:", err);
        }
      
        this.room.on("trackSubscribed", (track: RemoteTrack, pub: TrackPublication, participant: RemoteParticipant) => {
          if (track.kind === "audio" && track instanceof RemoteTrack) {
            const audioElement = track.attach();
            audioElement.style.display = 'none'; // Hide but keep in DOM
            document.body.appendChild(audioElement);
            console.log("Remote audio track attached from", participant.identity);
          }
        });
      
        this.room.on("dataReceived", (payload: Uint8Array, participant?: RemoteParticipant) => {
          try {
            // Check if this is a binary audio message or a JSON control message
            if (payload instanceof Uint8Array && payload.byteLength > 0) {
              // Handle binary audio data if needed
              return;
            }
            
            // Otherwise treat as JSON control message
            const msg: RTVIMessage = JSON.parse(new TextDecoder().decode(payload));
            this._messageHandler(msg);
          } catch (e) {
            console.error("Invalid data message", e);
          }
        });
      
        this.room.on("participantConnected", (participant: RemoteParticipant) => {
          console.log("Participant connected:", participant.identity);
        });
      
        this.room.on("connectionStateChanged", (state: ConnectionState) => {
          console.log("Room connection state changed:", state);
        });
      }      
  
    async disconnect(): Promise<void> {
      this.room.disconnect();
      this.state = "disconnected";
    }
  
    async initialize(options: RTVIClientOptions, messageHandler: (ev: RTVIMessage) => void): Promise<void> {
      this._messageHandler = messageHandler;
    }
  
    handleUserAudioStream(data: ArrayBuffer): void {
        // Check if microphone is enabled first
        if (!this.room.localParticipant.isMicrophoneEnabled) {
          console.log('Microphone is disabled, enabling it');
          this.enableMic(true);
        }

        if (this.options?.bufferLocalAudioUntilBotReady && this.state !== "ready") {
          this._audioBuffer.push(data.slice(0)); // Make a copy to avoid reference issues
          this._emitInternalMessage(LiveKitRTVIMessageType.AUDIO_BUFFERING_STARTED);
          return;
        }
      
        // We're ready, so no buffering — send audio immediately
        this._sendAudioBatch([data]);
      
        // Optionally notify that buffering has stopped (only once)
        if (this._audioBuffer.length > 0) {
          this._audioBuffer = [];
          this._emitInternalMessage(LiveKitRTVIMessageType.AUDIO_BUFFERING_STOPPED);
        }
      }
      
  
      _sendAudioBatch(dataBatch: ArrayBuffer[]): void {
        for (const chunk of dataBatch) {
          // Send the binary audio data directly without JSON stringification
          this.room.localParticipant.publishData(new Uint8Array(chunk), {
            reliable: true,
          });
        }
      }
      
  
    sendMessage(message: RTVIMessage): void {
      const payload = new TextEncoder().encode(JSON.stringify(message));
      this.room.localParticipant.publishData(payload, {
        reliable: true,
      });
    }
  
    async sendReadyMessage(): Promise<void> {
      this.state = "ready";
      this._emitInternalMessage(LiveKitRTVIMessageType.AUDIO_BUFFERING_STOPPED);
  
      if (this._audioBuffer.length > 0) {
        this._sendAudioBatch(this._audioBuffer);
        this._audioBuffer = [];
      }
    }
  
    async getAllMics(): Promise<MediaDeviceInfo[]> {
      return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    }
  
    async updateMic(deviceId: string): Promise<void> {
      const track = await createLocalAudioTrack({ deviceId: { exact: deviceId } });
      await this.room.localParticipant.publishTrack(track);
    }
  
    get selectedMic(): MediaDeviceInfo | Record<string, never> {
      return {}; // Store current mic ID to return it if needed
    }
  
    async getAllCams(): Promise<MediaDeviceInfo[]> {
      return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    }
  
    async updateCam(deviceId: string): Promise<void> {
      const track = await createLocalVideoTrack({ deviceId: { exact: deviceId } });
      await this.room.localParticipant.publishTrack(track);
    }
  
    get selectedCam(): MediaDeviceInfo | Record<string, never> {
      return {};
    }
  
    async getAllSpeakers(): Promise<MediaDeviceInfo[]> {
      return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput");
    }
  
    updateSpeaker(speakerId: string): void {
      // Not all browsers allow programmatic speaker selection
      console.warn("Speaker output selection is not implemented.");
    }
  
    get selectedSpeaker(): MediaDeviceInfo | Record<string, never> {
      return {};
    }
  
    enableMic(enable: boolean): void {
        try {
          this.room.localParticipant.setMicrophoneEnabled(enable);
          console.log(`Microphone ${enable ? 'enabled' : 'disabled'}`);
        } catch (err) {
          console.error('Error toggling microphone:', err);
        }
      }
      
  
    get isMicEnabled(): boolean {
      return this.room.localParticipant.isMicrophoneEnabled;
    }
  
    enableCam(enable: boolean): void {
      this.room.localParticipant.setCameraEnabled(enable);
    }
  
    get isCamEnabled(): boolean {
      return this.room.localParticipant.isCameraEnabled;
    }
  
    enableScreenShare(enable: boolean): void {
      console.warn("Screen sharing not implemented in this stub.");
    }
  
    get isSharingScreen(): boolean {
      return false;
    }
  
    tracks(): Tracks {
        const audioPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const videoPub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
        const screenAudioPub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
        const screenVideoPub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      
        return {
          local: {
            audio: audioPub?.track?.mediaStreamTrack,
            video: videoPub?.track?.mediaStreamTrack,
            screenAudio: screenAudioPub?.track?.mediaStreamTrack,
            screenVideo: screenVideoPub?.track?.mediaStreamTrack,
          },
        };
      }
      
      
      
  
    async preAuth(): Promise<void> {
      // Optional pre-auth logic if needed
    }
  
    async initDevices(): Promise<void> {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  }
  