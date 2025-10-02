/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import {GdmLiveAudioVisuals3D} from './visual-3d';

// Function Declarations for Tool Use
const changeSphereColorFunctionDeclaration: FunctionDeclaration = {
  name: 'changeSphereColor',
  description:
    'Changes the color of the glowing sphere in the center of the visualization.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      color: {
        type: Type.STRING,
        description:
          'The target color, for example "blue", "purple", or a hex code like "#FF0000".',
      },
    },
    required: ['color'],
  },
};

const changeRotationSpeedFunctionDeclaration: FunctionDeclaration = {
  name: 'changeRotationSpeed',
  description: 'Changes the rotation speed of the camera around the sphere.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      speedFactor: {
        type: Type.NUMBER,
        description:
          'A multiplier for the rotation speed. 1 is normal speed, 2 is double speed, 0.5 is half speed. 0 stops rotation.',
      },
    },
    required: ['speedFactor'],
  },
};

const changeBackgroundFunctionDeclaration: FunctionDeclaration = {
  name: 'changeBackground',
  description:
    "Changes the scene's background style. The default is a gradient.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      style: {
        type: Type.STRING,
        description:
          "The desired background style. Supported values are 'default' and 'starry'.",
      },
    },
    required: ['style'],
  },
};

const resetVisualsFunctionDeclaration: FunctionDeclaration = {
  name: 'resetVisuals',
  description:
    "Resets all visual elements—the sphere's color, rotation speed, and background—to their original default state.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() selectedVoice = 'Zephyr';
  @state() selectedPersona = 'Helpful Assistant';

  @query('gdm-live-audio-visuals-3d') visualizer!: GdmLiveAudioVisuals3D;

  private client: GoogleGenAI;
  // Use a promise to manage the session object to prevent race conditions.
  private sessionPromise: Promise<Session>;
  // Fix for Property 'webkitAudioContext' does not exist on type 'Window & typeof globalThis'.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // Fix for Property 'webkitAudioContext' does not exist on type 'Window & typeof globalThis'.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  // For error handling and retries
  private isConnecting = false;
  private retryCount = 0;
  private readonly maxRetries = 3;

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-family: sans-serif;
      font-size: 1.1em;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      transition: color 0.3s ease;
    }

    #status.error-message {
      color: #ff5252;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 12vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 20px;
    }

    .selectors {
      display: flex;
      gap: 20px;
    }

    .orb-button {
      outline: none;
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: rgba(29, 37, 51, 0.5);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1),
        inset 0 0 0 2px rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      padding: 0;
      margin: 0;
    }

    .orb-button:hover {
      background: rgba(29, 37, 51, 0.7);
      transform: scale(1.05);
    }

    .orb-button.recording {
      animation: pulse-red 2s infinite;
    }

    @keyframes pulse-red {
      0% {
        box-shadow: 0 0 25px rgba(255, 82, 82, 0.7),
          0 4px 30px rgba(0, 0, 0, 0.1),
          inset 0 0 0 2px rgba(255, 255, 255, 0.05);
      }
      50% {
        box-shadow: 0 0 40px rgba(255, 82, 82, 1),
          0 4px 30px rgba(0, 0, 0, 0.1),
          inset 0 0 0 2px rgba(255, 255, 255, 0.05);
      }
      100% {
        box-shadow: 0 0 25px rgba(255, 82, 82, 0.7),
          0 4px 30px rgba(0, 0, 0, 0.1),
          inset 0 0 0 2px rgba(255, 255, 255, 0.05);
      }
    }

    .orb-button svg {
      width: 40px;
      height: 40px;
      fill: white;
      transition: all 0.3s ease;
    }

    .selector-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    label {
      color: white;
      font-family: sans-serif;
    }

    select {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: white;
      border-radius: 12px;
      background-color: rgba(29, 37, 51, 0.5);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
      width: 180px;
      height: 48px;
      padding: 0 16px;
      cursor: pointer;
      font-size: 16px;
      -webkit-appearance: none;
      -moz-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: right 16px center;
      background-size: 1em;
      transition: background-color 0.2s ease;

      &:hover {
        background-color: rgba(29, 37, 51, 0.7);
      }

      option {
        background: #222;
        color: white;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private initSession(isRetry = false) {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    if (this.isConnecting) return;
    this.isConnecting = true;

    if (!isRetry) {
      this.retryCount = 0;
    }

    if (isRetry) {
      this.updateStatus(
        `Retrying connection... (Attempt ${this.retryCount}/${this.maxRetries})`,
      );
    } else {
      this.updateStatus('Connecting to the AI...');
    }

    const personaInstructions = {
      'Helpful Assistant':
        'You are a friendly and helpful conversational AI. You can control the 3D visuals in the app. You can change the sphere color, its rotation speed, and the background style. You can also reset the visuals to their default state. Listen carefully to the user and wait for them to finish their sentence before you respond. Your primary language is English, but you are multilingual. If the user speaks to you in another language, you should respond in that same language.',
      'Creative Storyteller':
        'You are a master storyteller. Weave imaginative and descriptive tales based on user prompts. Your responses should always be creative, engaging, and story-like. You can also control the visuals to match the mood of your story.',
      'Socratic Tutor':
        'You are a tutor who uses the Socratic method. Instead of giving direct answers, ask thought-provoking questions to help the user discover the answer for themselves. Guide them gently towards understanding. You can use the visuals to help illustrate your points.',
    };

    this.sessionPromise = this.client.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          this.updateStatus('Connection successful.');
          this.retryCount = 0; // Reset on successful connection
          this.isConnecting = false;
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.toolCall) {
            for (const fc of message.toolCall.functionCalls) {
              let result = 'ok';
              switch (fc.name) {
                case 'changeSphereColor':
                  this.visualizer.changeSphereColor(fc.args.color as string);
                  break;
                case 'changeRotationSpeed':
                  this.visualizer.changeRotationSpeed(
                    fc.args.speedFactor as number,
                  );
                  break;
                case 'changeBackground':
                  this.visualizer.changeBackground(
                    fc.args.style as 'default' | 'starry',
                  );
                  break;
                case 'resetVisuals':
                  this.visualizer.resetVisuals();
                  break;
                default:
                  console.warn(`Unknown function call: ${fc.name}`);
                  result = `Unknown function: ${fc.name}`;
              }
              this.sessionPromise.then((session) => {
                session.sendToolResponse({
                  functionResponses: {
                    id: fc.id,
                    name: fc.name,
                    response: {result: result},
                  },
                });
              });
            }
          }

          const audio =
            message.serverContent?.modelTurn?.parts[0]?.inlineData;

          if (audio) {
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(audio.data),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          const interrupted = message.serverContent?.interrupted;
          if (interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.error('Live session error:', e);
          // This event often precedes `onclose`, which handles reconnection.
          // We update the status here to inform the user immediately.
          this.updateError(
            'A network error occurred. Attempting to reconnect...',
          );
          this.isConnecting = false;
        },
        onclose: (e: CloseEvent) => {
          console.warn('Live session closed.', e);
          this.isConnecting = false;
          // Don't retry on clean close or if recording was manually stopped
          if (!e.wasClean && this.isRecording) {
            this.handleConnectionError(
              new Error(
                `${e.reason || 'Network error: Connection lost unexpectedly.'}`,
              ),
            );
          } else {
            this.updateStatus('Session closed.');
          }
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: this.selectedVoice}},
        },
        systemInstruction:
          personaInstructions[
            this.selectedPersona as keyof typeof personaInstructions
          ],
        tools: [
          {
            functionDeclarations: [
              changeSphereColorFunctionDeclaration,
              changeRotationSpeedFunctionDeclaration,
              changeBackgroundFunctionDeclaration,
              resetVisualsFunctionDeclaration,
            ],
          },
        ],
      },
    });

    this.sessionPromise.catch((e) => {
      this.isConnecting = false;
      console.error('Failed to initialize session:', e);
      this.handleConnectionError(e as Error);
    });
  }

  private handleConnectionError(e: Error) {
    let baseMessage = 'Connection to the AI lost.';
    // Check for specific error messages to provide better user feedback.
    if (e.message?.toLowerCase().includes('network')) {
      baseMessage = 'A network error occurred.';
    } else if (e.message?.toLowerCase().includes('unavailable')) {
      baseMessage = 'The AI service is temporarily unavailable.';
    }

    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      const delay = Math.pow(2, this.retryCount - 1) * 1000; // Exponential backoff
      this.updateError(`${baseMessage} Retrying in ${delay / 1000}s...`);
      setTimeout(() => this.initSession(true), delay);
    } else {
      this.updateError(
        `Could not reconnect. ${baseMessage} Please try again later.`,
      );
      this.stopRecording();
    }
  }

  private updateStatus(msg: string) {
    this.error = '';
    this.status = msg;
  }

  private updateError(msg: string) {
    this.status = '';
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.sessionPromise?.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('Listening...');
    } catch (err) {
      console.error('Error starting recording:', err);
      if (
        (err as Error).name === 'NotAllowedError' ||
        (err as Error).name === 'PermissionDeniedError'
      ) {
        this.updateError(
          'Microphone access denied. Please allow microphone access in your browser settings.',
        );
      } else {
        this.updateError(`Error starting recording: ${(err as Error).message}`);
      }
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Ready. Click the orb to start.');
  }

  private resetSession() {
    this.stopRecording();
    if (this.sessionPromise) {
      this.sessionPromise
        .then((session) => session.close())
        .catch((err) => {
          console.error('Error closing session:', err);
        });
    }
    this.initSession();
    this.updateStatus('Settings changed. Session reset.');
  }

  private onVoiceChange(e: Event) {
    this.selectedVoice = (e.target as HTMLSelectElement).value;
    this.resetSession();
  }

  private onPersonaChange(e: Event) {
    this.selectedPersona = (e.target as HTMLSelectElement).value;
    this.resetSession();
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  render() {
    const voices = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
    const personas = [
      'Helpful Assistant',
      'Creative Storyteller',
      'Socratic Tutor',
    ];

    const micIcon = html`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -960 960 960">
      <path
        d="M480-400q-50 0-85-35t-35-85v-200q0-50 35-85t85-35q50 0 85 35t35 85v200q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T520-520v-200q0-17-11.5-28.5T480-760q-17 0-28.5 11.5T440-720v200q0 17 11.5 28.5T480-480Zm0 280q-83 0-156-31.5T197-297q-24-24-28-58t10-66q14-31 43-52t68-21h180q39 0 68 21t43 52q14 32 10 66t-28 58q-54 54-127 85.5T480-200Zm0-80q54 0 99-20.5t71-55.5H310q26 35 71 55.5t99 20.5Z" />
    </svg>`;
    const stopIcon = html`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -960 960 960">
      <path d="M320-320v-320h320v320H320Z" />
    </svg>`;

    return html`
      <div>
        <div class="controls">
          <button
            class="orb-button ${this.isRecording ? 'recording' : ''}"
            @click=${this.toggleRecording}>
            ${this.isRecording ? stopIcon : micIcon}
          </button>
          <div class="selectors" ?hidden=${this.isRecording}>
            <div class="selector-group">
              <label for="voice-select">Voice</label>
              <select id="voice-select" @change=${this.onVoiceChange}>
                ${voices.map(
                  (voice) => html`
                    <option
                      value=${voice}
                      ?selected=${voice === this.selectedVoice}>
                      ${voice}
                    </option>
                  `,
                )}
              </select>
            </div>
            <div class="selector-group">
              <label for="persona-select">Persona</label>
              <select id="persona-select" @change=${this.onPersonaChange}>
                ${personas.map(
                  (persona) => html`
                    <option
                      value=${persona}
                      ?selected=${persona === this.selectedPersona}>
                      ${persona}
                    </option>
                  `,
                )}
              </select>
            </div>
          </div>
        </div>

        <div id="status" class=${this.error ? 'error-message' : ''}>
          ${this.error || this.status}
        </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
