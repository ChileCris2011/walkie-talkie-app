// app/index.tsx - WebRTC Implementation with react-native-webrtc
import React, { useState, useEffect, useRef } from 'react';
import {
    StyleSheet,
    Text,
    View,
    TouchableOpacity,
    ScrollView,
    Alert,
    Platform,
    Vibration,
    AppState,
    AppStateStatus,
} from 'react-native';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import io from 'socket.io-client';
import { Ionicons } from '@expo/vector-icons';

// Importar servicio de segundo plano
import { WalkieTalkieBackgroundService, isBackgroundServiceAvailable } from './services/BackgroundService';

// Importar WebRTC según plataforma
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;

if (Platform.OS === 'web') {
    // Para web, usar la API nativa del navegador
    RTCPeerConnection = window.RTCPeerConnection;
    RTCSessionDescription = window.RTCSessionDescription;
    RTCIceCandidate = window.RTCIceCandidate;
    mediaDevices = navigator.mediaDevices;
} else {
    // Para React Native, usar react-native-webrtc
    try {
        const webrtc = require('react-native-webrtc');
        RTCPeerConnection = webrtc.RTCPeerConnection;
        RTCSessionDescription = webrtc.RTCSessionDescription;
        RTCIceCandidate = webrtc.RTCIceCandidate;
        mediaDevices = webrtc.mediaDevices;
    } catch (e) {
        console.log('react-native-webrtc not installed, WebRTC features disabled');
    }
}

const SERVER_URL = 'https://walkie-server-ov27.onrender.com';

const CHANNELS = [
    { id: '1', name: 'Canal 1', frequency: '462.5625 MHz' },
    { id: '2', name: 'Canal 2', frequency: '462.5875 MHz' },
    { id: '3', name: 'Canal 3', frequency: '462.6125 MHz' },
    { id: '4', name: 'Canal 4', frequency: '462.6375 MHz' },
    { id: '5', name: 'Canal 5', frequency: '462.6625 MHz' },
];

class AudioService {
    beepSound: Audio.Sound | null = null;
    sounds: {
        push?: Audio.Sound;
        release?: Audio.Sound;
        incoming?: Audio.Sound;
        join?: Audio.Sound;
        leave?: Audio.Sound;
    } = {};

    async initialize() {
        try {
            const permission = await Audio.requestPermissionsAsync();
            if (!permission.granted) {
                return false;
            }

            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                shouldDuckAndroid: true,
                playThroughEarpieceAndroid: false,
                interruptionModeIOS: 1, // INTERRUPTION_MODE_IOS_DO_NOT_MIX
                interruptionModeAndroid: 1, // INTERRUPTION_MODE_ANDROID_DO_NOT_MIX
            });

            if (Platform.OS !== 'web') {
                try {
                    const soundFiles = {
                        push: require('../assets/sounds/push.m4a'),
                        release: require('../assets/sounds/release.wav'),
                        incoming: require('../assets/sounds/incoming.wav'),
                        join: require('../assets/sounds/join.wav'),
                        leave: require('../assets/sounds/leave.wav'),
                    };

                    for (const [key, file] of Object.entries(soundFiles)) {
                        try {
                            const { sound } = await Audio.Sound.createAsync(file, { volume: 0.8 });
                            this.sounds[key as keyof typeof this.sounds] = sound;
                        } catch (e) {
                            console.log(`Could not load sound: ${key}`);
                        }
                    }
                } catch (e) {
                    console.log(`Sound files not found - using fallback`);
                }
            }

            return true;
        } catch (error) {
            console.error('Error initializing audio:', error);
            return false;
        }
    }

    async playBeepSound(type: 'push' | 'release' | 'incoming' | 'join' | 'leave') {
        if (Platform.OS === 'web') {
            this.playBeep(type);
        } else {
            const sound = this.sounds[type];
            if (sound) {
                try {
                    await sound.replayAsync();
                } catch (error) {
                    console.log(`Could not play ${type} sound:`, error);
                }
            }
        }
    }

    playBeep(type: 'push' | 'release' | 'incoming' | 'join' | 'leave') {
        if (Platform.OS !== 'web') return;

        try {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

            const configs = {
                push: { frequency: 800, duration: 100 },
                release: { frequency: 600, duration: 80 },
                incoming: { frequency: 1000, duration: 50, double: true },
                join: { frequency: 600, duration: 100, sequence: [600, 900] },
                leave: { frequency: 900, duration: 100, sequence: [900, 600] },
            };

            const config = configs[type];

            if (config.sequence) {
                config.sequence.forEach((freq, i) => {
                    setTimeout(() => this.generateTone(audioContext, freq, 100), i * 150);
                });
            } else if (config.double) {
                this.generateTone(audioContext, config.frequency, config.duration);
                setTimeout(() => this.generateTone(audioContext, 1200, config.duration), 100);
            } else {
                this.generateTone(audioContext, config.frequency, config.duration);
            }
        } catch (error) {
            console.log('Beep not available:', error);
        }
    }

    generateTone(audioContext: AudioContext, frequency: number, duration: number) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';

        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';

        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + duration / 1000);
    }

    cleanup() {
        if (this.beepSound) {
            this.beepSound.unloadAsync();
        }
        Object.values(this.sounds).forEach(sound => {
            if (sound) sound.unloadAsync();
        });
    }
}

// WebRTC Service compatible con React Native y Web
class WebRTCService {
    localStream: any = null;
    peerConnections: Map<string, any> = new Map();
    audioContext: AudioContext | null = null;
    audioDestination: any = null;
    socket: any = null;
    onTransmissionStart: ((userId: string) => void) | null = null;
    onTransmissionEnd: ((userId: string) => void) | null = null;
    isWebRTCAvailable: boolean = false;

    async initialize() {
        try {
            // Verificar si WebRTC está disponible
            this.isWebRTCAvailable = !!(RTCPeerConnection && mediaDevices);

            if (!this.isWebRTCAvailable) {
                console.log('WebRTC not available on this platform');
                return false;
            }

            // Initialize audio context solo en web para mezclar streams
            if (Platform.OS === 'web') {
                this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                this.audioDestination = this.audioContext.createMediaStreamDestination();
            }

            return true;
        } catch (error) {
            console.error('Error initializing WebRTC:', error);
            return false;
        }
    }

    async startLocalStream() {
        try {
            if (!this.isWebRTCAvailable) {
                console.log('WebRTC not available');
                return false;
            }

            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000,
                },
                video: false,
            };

            this.localStream = await mediaDevices.getUserMedia(constraints);

            // Inicialmente mutear el stream
            this.localStream.getAudioTracks().forEach((track: any) => {
                track.enabled = false;
            });

            console.log('Local stream started');
            return true;
        } catch (error) {
            console.error('Error starting local stream:', error);
            return false;
        }
    }

    async stopLocalStream() {
        if (this.localStream) {
            this.localStream.getTracks().forEach((track: any) => track.stop());
            this.localStream = null;
        }
    }

    createPeerConnection(remoteUserId: string): any {
        if (!this.isWebRTCAvailable) return null;

        const config: any = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
            ],
        };

        const pc = new RTCPeerConnection(config);

        // Add local stream tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach((track: any) => {
                pc.addTrack(track, this.localStream);
            });
        }

        // Handle incoming tracks
        pc.ontrack = (event: any) => {
            console.log('Received remote track from', remoteUserId);
            const remoteStream = event.streams[0];

            if (this.onTransmissionStart) {
                this.onTransmissionStart(remoteUserId);
            }

            // Play remote audio
            this.playRemoteStream(remoteStream, remoteUserId);
        };
        // Handle ICE candidates
        pc.onicecandidate = (event: any) => {
            if (event.candidate && this.socket) {
                console.log(`Sending ICE candidate to ${remoteUserId}`);
                this.socket.emit('ice-candidate', {
                    to: remoteUserId,
                    candidate: event.candidate,
                });
            } else if (!event.candidate) {
                console.log(`ICE gathering complete for ${remoteUserId}`);
            }
        };

        // Handle ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state with ${remoteUserId}:`, pc.iceConnectionState);
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log(`Connection state with ${remoteUserId}:`, pc.connectionState);

            if (pc.connectionState === 'connected') {
                console.log(`✅ Successfully connected to ${remoteUserId}`);
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                console.log(`❌ Connection ${pc.connectionState} with ${remoteUserId}`);
                this.closePeerConnection(remoteUserId);
                if (this.onTransmissionEnd) {
                    this.onTransmissionEnd(remoteUserId);
                }
            }
        };

        this.peerConnections.set(remoteUserId, pc);
        return pc;
    }

    playRemoteStream(stream: any, userId: string) {
        try {
            if (Platform.OS === 'web') {
                // En web, crear elemento de audio HTML5
                const audio = document.createElement('audio');
                audio.srcObject = stream;
                audio.autoplay = true;
                audio.volume = 1.0;

                // Reproducir con manejo de errores
                const playPromise = audio.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        console.log('Audio autoplay prevented, trying with user interaction:', e);
                    });
                }

                // Mezclar con audio context si está disponible
                if (this.audioContext && this.audioDestination) {
                    try {
                        const source = this.audioContext.createMediaStreamSource(stream);
                        source.connect(this.audioDestination);
                    } catch (e) {
                        console.log('Could not connect to audio context:', e);
                    }
                }
            } else {
                // En React Native con react-native-webrtc
                // El audio se reproduce automáticamente
                console.log('Audio stream from', userId, 'will play automatically');
            }
        } catch (error) {
            console.error('Error playing remote stream:', error);
        }
    }

    async createOffer(remoteUserId: string) {
        const pc = this.peerConnections.get(remoteUserId);
        if (!pc) {
            console.error(`No peer connection for ${remoteUserId}`);
            return;
        }

        try {
            console.log(`Creating offer for ${remoteUserId}`);
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
            });
            await pc.setLocalDescription(offer);

            if (this.socket) {
                console.log(`Sending offer to ${remoteUserId}`);
                this.socket.emit('webrtc-offer', {
                    to: remoteUserId,
                    offer: pc.localDescription,
                });
            }
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    async handleOffer(fromUserId: string, offer: any) {
        let pc = this.peerConnections.get(fromUserId);
        if (!pc) {
            pc = this.createPeerConnection(fromUserId);
        }

        if (!pc) return;

        try {
            // Verificar el estado de señalización antes de establecer descripción remota
            if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
                console.log(`Cannot handle offer in state: ${pc.signalingState}`);
                return;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            if (this.socket) {
                this.socket.emit('webrtc-answer', {
                    to: fromUserId,
                    answer: pc.localDescription,
                });
            }
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(fromUserId: string, answer: any) {
        const pc = this.peerConnections.get(fromUserId);
        if (!pc) {
            console.log(`No peer connection found for ${fromUserId}`);
            return;
        }

        try {
            // Solo procesar la respuesta si estamos esperando una
            if (pc.signalingState !== 'have-local-offer') {
                console.log(`Cannot handle answer in state: ${pc.signalingState}`);
                return;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`Answer from ${fromUserId} accepted`);
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(fromUserId: string, candidate: any) {
        const pc = this.peerConnections.get(fromUserId);
        if (!pc) return;

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    enableAudio(enabled: boolean) {
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach((track: any) => {
                track.enabled = enabled;
            });
        }
    }

    closePeerConnection(userId: string) {
        const pc = this.peerConnections.get(userId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(userId);
        }
    }

    closeAllConnections() {
        this.peerConnections.forEach((pc, userId) => {
            pc.close();
        });
        this.peerConnections.clear();
    }

    setSocket(socket: any) {
        this.socket = socket;
    }

    cleanup() {
        this.stopLocalStream();
        this.closeAllConnections();
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

// Connection Service
class ConnectionService {
    socket: any = null;
    isConnected: boolean = false;
    serverUrl: string = '';
    listeners: { [key: string]: (data: any) => void } = {};

    connect(serverUrl: string) {
        this.serverUrl = serverUrl;

        console.log(`Connecting to ${serverUrl}...`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5,
        });

        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.isConnected = true;
            this.emit('connection-status', true);
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.isConnected = false;
            this.emit('connection-status', false);
        });

        this.socket.on('connect_error', (error: any) => {
            console.error('Connection error:', error.message);
            this.emit('connection-error', error.message);
        });

        this.socket.on('user-joined', (userId: string) => {
            console.log(`User joined: ${userId}`);
            this.emit('user-joined', userId);
        });

        this.socket.on('user-left', (userId: string) => {
            console.log(`User left: ${userId}`);
            this.emit('user-left', userId);
        });

        this.socket.on('channel-users', (users: string[]) => {
            console.log(`Channel users: ${users.length}`);
            this.emit('channel-users', users);
        });

        // WebRTC signaling
        this.socket.on('webrtc-offer', (data: any) => {
            this.emit('webrtc-offer', data);
        });

        this.socket.on('webrtc-answer', (data: any) => {
            this.emit('webrtc-answer', data);
        });

        this.socket.on('ice-candidate', (data: any) => {
            this.emit('ice-candidate', data);
        });

        this.socket.on('transmission-start', (data: any) => {
            this.emit('transmission-start', data);
        });

        this.socket.on('transmission-end', (data: any) => {
            this.emit('transmission-end', data);
        });

        return this.socket;
    }

    joinChannel(channelId: string, userId: string) {
        if (!this.socket || !this.isConnected) return false;

        console.log(`Joining channel ${channelId} as ${userId}`);
        this.socket.emit('join-channel', { channelId, userId });
        return true;
    }

    leaveChannel(channelId: string, userId: string) {
        if (!this.socket) return;

        console.log(`Leaving channel ${channelId}`);
        this.socket.emit('leave-channel', { channelId, userId });
    }

    notifyTransmissionStart(channelId: string, userId: string) {
        if (!this.socket) return;
        this.socket.emit('transmission-start', { channelId, userId });
    }

    notifyTransmissionEnd(channelId: string, userId: string) {
        if (!this.socket) return;
        this.socket.emit('transmission-end', { channelId, userId });
    }

    on(event: string, callback: (data: any) => void) {
        this.listeners[event] = callback;
    }

    emit(event: string, data: any) {
        if (this.listeners[event]) {
            this.listeners[event](data);
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.isConnected = false;
        }
    }

    getSocket() {
        return this.socket;
    }
}

export default function WalkieTalkieScreen() {
    const [userId] = useState(`user_${Math.random().toString(36).substr(2, 9)}`);
    const [currentChannel, setCurrentChannel] = useState<typeof CHANNELS[0] | null>(null);
    const [isPushing, setIsPushing] = useState(false);
    const [dndMode, setDndMode] = useState(false);
    const [muteReceive, setMuteReceive] = useState(false);
    const [muteSend, setMuteSend] = useState(false);
    const [channelUsers, setChannelUsers] = useState<string[]>([]);
    const [recentMessages, setRecentMessages] = useState<any[]>([]);
    const [isInitialized, setIsInitialized] = useState(false);
    const [transmissionTime, setTransmissionTime] = useState(0);
    const [isConnected, setIsConnected] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [activeTransmissions, setActiveTransmissions] = useState<Set<string>>(new Set());
    const [isWebRTCAvailable, setIsWebRTCAvailable] = useState(false);
    const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
    const [backgroundServiceActive, setBackgroundServiceActive] = useState(false);

    const dndModeRef = useRef(dndMode);
    const muteReceiveRef = useRef(muteReceive);
    const currentChannelRef = useRef(currentChannel);
    const appStateRef = useRef(appState);

    const audioService = useRef(new AudioService());
    const webrtcService = useRef(new WebRTCService());
    const connectionService = useRef(new ConnectionService());
    const transmissionTimer = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        dndModeRef.current = dndMode;
    }, [dndMode]);

    useEffect(() => {
        muteReceiveRef.current = muteReceive;
    }, [muteReceive]);

    useEffect(() => {
        appStateRef.current = appState;
    }, [appState]);

    useEffect(() => {
        initializeApp();

        // Monitorear estado de la app
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
            audioService.current.cleanup();
            webrtcService.current.cleanup();
            connectionService.current.disconnect();
            try {
                deactivateKeepAwake();
            } catch (e) {
                console.log('Keep awake already deactivated');
            }
            if (isBackgroundServiceAvailable()) {
                WalkieTalkieBackgroundService.stop();
            }
        };
    }, []);

    const initializeApp = async () => {
        const audioInit = await audioService.current.initialize();
        const webrtcInit = await webrtcService.current.initialize();
        setIsWebRTCAvailable(webrtcInit);
        setIsInitialized(audioInit);
        // Inicializar servicio de segundo plano
        if (isBackgroundServiceAvailable()) {
            await WalkieTalkieBackgroundService.initialize();
        }

        if (!audioInit) {
            Alert.alert(
                'Permisos Requeridos',
                'Esta app necesita acceso al micrófono para funcionar.',
                [{ text: 'OK' }]
            );
            return;
        }

        try {
            const socket = connectionService.current.connect(SERVER_URL);
            webrtcService.current.setSocket(socket);

            connectionService.current.on('connection-status', (connected: boolean) => {
                setIsConnected(connected);
                if (connected) {
                    setConnectionError(null);
                }
            });

            connectionService.current.on('connection-error', (error: string) => {
                setConnectionError(error);
            });

            connectionService.current.on('user-joined', (joinedUserId: string) => {
                setChannelUsers((prev) => [...prev, joinedUserId]);
                playSound('join');

                // Initiate WebRTC connection with new user (solo el usuario existente inicia)
                if (currentChannelRef.current && webrtcService.current.isWebRTCAvailable) {
                    setTimeout(() => {
                        console.log(`New user joined, initiating connection: ${joinedUserId}`);
                        const pc = webrtcService.current.createPeerConnection(joinedUserId);
                        if (pc) {
                            webrtcService.current.createOffer(joinedUserId);
                        }
                    }, 1000);
                }
            });

            connectionService.current.on('user-left', (leftUserId: string) => {
                setChannelUsers((prev) => prev.filter((u) => u !== leftUserId));
                webrtcService.current.closePeerConnection(leftUserId);
                setActiveTransmissions(prev => {
                    const next = new Set(prev);
                    next.delete(leftUserId);
                    return next;
                });
            });

            connectionService.current.on('channel-users', (users: string[]) => {
                setChannelUsers(users);

                // Establecer conexiones WebRTC con usuarios existentes (solo si somos quien se une)
                // Esperamos un poco para asegurarnos de que el stream local esté listo
                if (webrtcService.current.isWebRTCAvailable && currentChannelRef.current) {
                    setTimeout(() => {
                        users.forEach(user => {
                            if (!webrtcService.current.peerConnections.has(user)) {
                                console.log(`Initiating connection with existing user: ${user}`);
                                webrtcService.current.createPeerConnection(user);
                                webrtcService.current.createOffer(user);
                            }
                        });
                    }, 1500);
                }
            });

            // WebRTC signaling handlers
            connectionService.current.on('webrtc-offer', async (data: any) => {
                await webrtcService.current.handleOffer(data.from, data.offer);
            });

            connectionService.current.on('webrtc-answer', async (data: any) => {
                await webrtcService.current.handleAnswer(data.from, data.answer);
            });

            connectionService.current.on('ice-candidate', async (data: any) => {
                await webrtcService.current.handleIceCandidate(data.from, data.candidate);
            });

            connectionService.current.on('transmission-start', (data: any) => {
                console.log(`${data.userId} started transmitting`);
                setActiveTransmissions(prev => new Set(prev).add(data.userId));
                addMessage(data.userId);

                if (!dndModeRef.current && !muteReceiveRef.current) {
                    playSound('incoming');

                    // Notificar si la app está en segundo plano
                    if (appStateRef.current.match(/inactive|background/) && isBackgroundServiceAvailable()) {
                        WalkieTalkieBackgroundService.showTransmissionNotification(data.userId, false);
                    }
                }
            });

            connectionService.current.on('transmission-end', (data: any) => {
                console.log(`${data.userId} stopped transmitting`);
                setActiveTransmissions(prev => {
                    const next = new Set(prev);
                    next.delete(data.userId);
                    return next;
                });
            });
            // Set up WebRTC callbacks
            webrtcService.current.onTransmissionStart = (userId: string) => {
                setActiveTransmissions(prev => new Set(prev).add(userId));
            };

            webrtcService.current.onTransmissionEnd = (userId: string) => {
                setActiveTransmissions(prev => {
                    const next = new Set(prev);
                    next.delete(userId);
                    return next;
                });
            };

        } catch (error) {
            console.error('Failed to connect:', error);
            setConnectionError('No se pudo conectar al servidor');
        }
    };

    const playSound = (type: 'push' | 'release' | 'incoming' | 'join' | 'leave') => {
        const isDND = dndModeRef.current;
        const isMuted = muteReceiveRef.current;

        if (isDND && type !== 'push' && type !== 'release') {
            return;
        }

        if (isMuted && type === 'incoming') {
            return;
        }

        audioService.current.playBeepSound(type);

        if (Platform.OS !== 'web' && !isDND) {
            try {
                if (type === 'push') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                    Vibration.vibrate(100);
                } else if (type === 'release') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    Vibration.vibrate(50);
                } else if (type === 'incoming') {
                    if (!isMuted) {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        Vibration.vibrate([100, 50, 100]);
                    }
                }
            } catch (error) {
                console.log('Haptic feedback not available');
            }
        }
    };

    const addMessage = (fromUserId: string) => {
        const msg = {
            userId: fromUserId,
            timestamp: Date.now(),
            type: 'audio',
        };
        setRecentMessages((prev) => [...prev, msg].slice(-10));

        // Notificar si la app está en segundo plano y no es DND
        if (appStateRef.current.match(/inactive|background/) &&
            !dndModeRef.current &&
            isBackgroundServiceAvailable()) {
            const isOwn = fromUserId === userId;
            if (!isOwn) { // Solo notificar mensajes de otros
                WalkieTalkieBackgroundService.showTransmissionNotification(fromUserId, false);
            }
        }
    };

    const joinChannel = async (channel: typeof CHANNELS[0]) => {
        if (!isInitialized) {
            Alert.alert(
                'Error',
                'No se pudo inicializar el audio. Verifica los permisos de micrófono.'
            );
            return;
        }

        if (!isConnected) {
            Alert.alert(
                'Sin Conexión',
                'No estás conectado al servidor. Verifica tu conexión a internet.'
            );
            return;
        }

        if (currentChannel) {
            connectionService.current.leaveChannel(currentChannel.id, userId);
            webrtcService.current.closeAllConnections();
            webrtcService.current.stopLocalStream();

            // Detener servicio anterior
            if (isBackgroundServiceAvailable()) {
                await WalkieTalkieBackgroundService.stop();
            }
        }

        setCurrentChannel(channel);
        connectionService.current.joinChannel(channel.id, userId);
        playSound('join');
        setRecentMessages([]);
        setActiveTransmissions(new Set());

        // Start local media stream
        if (isWebRTCAvailable) {
            await webrtcService.current.startLocalStream();
        }

        // Activar keep awake
        try {
            await activateKeepAwakeAsync();
        } catch (e) {
            console.log('Keep awake already active or not available');
        }

        // Iniciar servicio en segundo plano
        if (isBackgroundServiceAvailable()) {
            await WalkieTalkieBackgroundService.start(channel.name, userId);
            setBackgroundServiceActive(true);
            console.log('Background service started for channel:', channel.name);
        }
    };

    const leaveChannel = () => {
        if (currentChannel) {
            connectionService.current.leaveChannel(currentChannel.id, userId);
            webrtcService.current.stopLocalStream();
            webrtcService.current.closeAllConnections();
            setCurrentChannel(null);
            setChannelUsers([]);
            setRecentMessages([]);
            setActiveTransmissions(new Set());
            playSound('leave');

            // Detener servicio en segundo plano
            if (isBackgroundServiceAvailable()) {
                WalkieTalkieBackgroundService.stop();
                setBackgroundServiceActive(false);
                console.log('Background service stopped');
            }

            try {
                deactivateKeepAwake();
            } catch (e) {
                console.log('Keep awake already deactivated');
            }
        }
    };

    const handlePushStart = async () => {
        if (!currentChannel || muteSend || isPushing) return;

        setIsPushing(true);
        setTransmissionTime(0);
        playSound('push');

        connectionService.current.notifyTransmissionStart(currentChannel.id, userId);

        transmissionTimer.current = setInterval(() => {
            setTransmissionTime((prev) => prev + 0.1);
        }, 100);

        addMessage(userId);

        // Habilitar audio en WebRTC
        if (isWebRTCAvailable) {
            webrtcService.current.enableAudio(true);
        }
    };

    const handlePushEnd = async () => {
        if (!currentChannel || !isPushing) return;

        setIsPushing(false);
        playSound('release');

        if (transmissionTimer.current) {
            clearInterval(transmissionTimer.current);
            transmissionTimer.current = null;
        }

        connectionService.current.notifyTransmissionEnd(currentChannel.id, userId);
        // Deshabilitar audio en WebRTC
        if (isWebRTCAvailable) {
            webrtcService.current.enableAudio(false);
        }
    };

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Text style={styles.headerTitle}>Walkie-Talkie WebRTC</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons
                            name={isConnected ? 'checkmark-circle' : connectionError ? 'close-circle' : 'alert-circle'}
                            size={14}
                            color={isConnected ? '#22c55e' : '#ef4444'}
                        />
                        <Text style={styles.headerSubtitle}>
                            {isConnected ? 'Conectado' : connectionError ? 'Desconectado' : 'Conectando...'}
                        </Text>
                    </View>
                </View>

                <View style={styles.headerButtons}>
                    <TouchableOpacity
                        style={[styles.iconButton, dndMode && styles.iconButtonActive]}
                        onPress={() => setDndMode(!dndMode)}
                    >
                        <Ionicons
                            name={dndMode ? "notifications-off" : "notifications"}
                            size={20}
                            color={"#fff"}
                        />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.iconButton, muteReceive && styles.iconButtonActive]}
                        onPress={() => setMuteReceive(!muteReceive)}
                    >
                        <Ionicons
                            name={muteReceive ? "volume-mute" : "volume-high"}
                            size={20}
                            color={"#fff"}
                        />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.iconButton, muteSend && styles.iconButtonActive]}
                        onPress={() => setMuteSend(!muteSend)}
                    >
                        <Ionicons
                            name={muteSend ? "mic-off" : "mic"}
                            size={20}
                            color={"#fff"}
                        />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Main Content */}
            <ScrollView style={styles.content}>
                {!currentChannel ? (
                    <View style={styles.channelList}>
                        <Text style={styles.sectionTitle}>Selecciona un Canal</Text>
                        {!isWebRTCAvailable && (
                            <View style={styles.warningBox}>
                                <Ionicons name="information-circle" size={16} color="#000" />
                                <Text style={styles.warningText}>
                                    WebRTC no disponible - instala react-native-webrtc
                                </Text>
                            </View>
                        )}
                        {!isConnected && (
                            <View style={[styles.warningBox, { backgroundColor: '#ef4444' }]}>
                                <Ionicons name="close-circle" size={16} color="#fff" />
                                <Text style={[styles.warningText, { color: '#fff' }]}>
                                    Sin conexión al servidor
                                </Text>
                            </View>
                        )}
                        {CHANNELS.map((channel) => (
                            <TouchableOpacity
                                key={channel.id}
                                style={styles.channelButton}
                                onPress={() => joinChannel(channel)}
                                disabled={!isInitialized}
                            >
                                <View>
                                    <Text style={styles.channelName}>{channel.name}</Text>
                                    <Text style={styles.channelFreq}>{channel.frequency}</Text>
                                </View>
                                <Ionicons name="radio" size={22} color="#94a3b8" />
                            </TouchableOpacity>
                        ))}
                    </View>
                ) : (
                    <View style={styles.channelView}>
                        {/* Channel Info */}
                        <View style={styles.channelInfo}>
                            <View style={styles.channelHeader}>
                                <View>
                                    <Text style={styles.channelTitle}>{currentChannel.name}</Text>
                                    <Text style={styles.channelFreqActive}>
                                        {currentChannel.frequency}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.leaveButton}
                                    onPress={leaveChannel}
                                >
                                    <Ionicons name="exit-outline" size={18} color="#fff" style={{ marginRight: 4 }} />
                                    <Text style={styles.leaveButtonText}>Salir</Text>
                                </TouchableOpacity>
                            </View>
                            <View style={styles.userCountContainer}>
                                <Ionicons name="people" size={14} color="#94a3b8" />
                                <Text style={styles.userCount}>
                                    {channelUsers.length + 1} usuario(s) conectado(s)
                                </Text>
                            </View>
                            {activeTransmissions.size > 0 && (
                                <View style={styles.activeTransmissionsContainer}>
                                    <Ionicons name="radio" size={14} color="#ef4444" />
                                    <Text style={styles.activeTransmissionsText}>
                                        {activeTransmissions.size} transmitiendo ahora
                                    </Text>
                                </View>
                            )}
                            {backgroundServiceActive && Platform.OS !== 'web' && (
                                <View style={[styles.activeTransmissionsContainer, { borderTopWidth: 0, marginTop: 4, paddingTop: 4 }]}>
                                    <Ionicons name="shield-checkmark" size={14} color="#22c55e" />
                                    <Text style={[styles.activeTransmissionsText, { color: '#22c55e' }]}>
                                        Servicio en segundo plano activo
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Activity Feed */}
                        <View style={styles.activityFeed}>
                            <View style={styles.activityTitleContainer}>
                                <Ionicons name="list" size={14} color="#94a3b8" />
                                <Text style={styles.activityTitle}>Actividad Reciente</Text>
                            </View>
                            {recentMessages.length === 0 ? (
                                <View style={styles.emptyActivity}>
                                    <Ionicons name="radio-outline" size={48} color="#64748b" style={{ opacity: 0.5, marginBottom: 8 }} />
                                    <Text style={styles.emptyText}>Esperando transmisiones...</Text>
                                    <Text style={styles.emptyHint}>
                                        Mantén presionado el botón para hablar
                                    </Text>
                                </View>
                            ) : (
                                <ScrollView>
                                    {recentMessages.map((msg, idx) => (
                                        <View key={idx} style={styles.messageItem}>
                                            <View
                                                style={[
                                                    styles.messageDot,
                                                    msg.userId === userId && styles.messageDotSelf,
                                                    activeTransmissions.has(msg.userId) && styles.messageDotActive,
                                                ]}
                                            />
                                            <View style={styles.messageContent}>
                                                <Text style={styles.messageUser}>
                                                    {msg.userId === userId ? 'Tú' : msg.userId}
                                                </Text>
                                                <Text style={styles.messageTime}>
                                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                                </Text>
                                            </View>
                                            {activeTransmissions.has(msg.userId) && (
                                                <Ionicons name="radio" size={16} color="#ef4444" />
                                            )}
                                        </View>
                                    ))}
                                </ScrollView>
                            )}
                        </View>

                        {/* Push to Talk Button */}
                        <View style={styles.pttContainer}>
                            {isPushing && (
                                <Text style={styles.transmissionTime}>
                                    {transmissionTime.toFixed(1)}s
                                </Text>
                            )}
                            <TouchableOpacity
                                style={[
                                    styles.pttButton,
                                    isPushing && styles.pttButtonActive,
                                    muteSend && styles.pttButtonDisabled,
                                ]}
                                onPressIn={handlePushStart}
                                onPressOut={handlePushEnd}
                                disabled={muteSend}
                                activeOpacity={0.8}
                            >
                                <Ionicons name="mic" size={32} color="#fff" />
                                <Text style={styles.pttText}>
                                    {muteSend
                                        ? 'MUTE'
                                        : isPushing
                                            ? 'TRANSMITIENDO'
                                            : 'MANTÉN PARA HABLAR'}
                                </Text>
                                {isPushing && (
                                    <View style={styles.recordingIndicator}>
                                        <View style={styles.recordingDot} />
                                        <Text style={styles.recordingText}>EN VIVO</Text>
                                    </View>
                                )}
                            </TouchableOpacity>
                            {isWebRTCAvailable && (
                                <Text style={styles.webrtcIndicator}>
                                    🔊 WebRTC Streaming
                                </Text>
                            )}
                        </View>
                    </View>
                )}
            </ScrollView>

            {/* Status Bar */}
            <View style={styles.statusBar}>
                <View style={styles.statusBarContent}>
                    <View style={styles.statusItem}>
                        <Ionicons
                            name={dndMode ? "notifications-off" : "notifications"}
                            size={12}
                            color={dndMode ? "#ef4444" : "#94a3b8"}
                        />
                        <Text style={[styles.statusText, dndMode && { color: '#ef4444' }]}>
                            {dndMode ? 'DND' : 'Normal'}
                        </Text>
                    </View>

                    <View style={styles.statusItem}>
                        <Ionicons
                            name={muteReceive ? "volume-mute" : "volume-high"}
                            size={12}
                            color={muteReceive ? "#ef4444" : "#94a3b8"}
                        />
                        <Text style={[styles.statusText, muteReceive && { color: '#ef4444' }]}>
                            {muteReceive ? 'Mute' : 'Audio'}
                        </Text>
                    </View>

                    <View style={styles.statusItem}>
                        <Ionicons name="finger-print" size={12} color="#94a3b8" />
                        <Text style={styles.statusText}>
                            {userId.slice(0, 8)}
                        </Text>
                    </View>

                    {isWebRTCAvailable && (
                        <View style={styles.statusItem}>
                            <Ionicons name="wifi" size={12} color="#22c55e" />
                            <Text style={styles.statusText}>WebRTC</Text>
                        </View>
                    )}
                </View>
            </View>
        </View>
    );
}
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0f172a',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        paddingTop: Platform.OS === 'android' ? 40 : 16,
        backgroundColor: '#1e293b',
        borderBottomWidth: 1,
        borderBottomColor: '#334155',
    },
    headerLeft: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#fff',
    },
    headerSubtitle: {
        fontSize: 12,
        color: '#94a3b8',
    },
    headerButtons: {
        flexDirection: 'row',
        gap: 8,
    },
    iconButton: {
        width: 40,
        height: 40,
        borderRadius: 8,
        backgroundColor: '#334155',
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconButtonActive: {
        backgroundColor: '#ef4444',
    },
    content: {
        flex: 1,
        padding: 16,
    },
    channelList: {
        gap: 12,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#fff',
        marginBottom: 12,
    },
    warningBox: {
        padding: 12,
        backgroundColor: '#fbbf24',
        borderRadius: 8,
        marginBottom: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    warningText: {
        color: '#000',
        fontSize: 14,
        fontWeight: '600',
        flex: 1,
    },
    channelButton: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        backgroundColor: '#1e293b',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#334155',
        marginBottom: 12,
    },
    channelName: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#fff',
    },
    channelFreq: {
        fontSize: 14,
        color: '#94a3b8',
    },
    channelView: {
        flex: 1,
    },
    channelInfo: {
        padding: 16,
        backgroundColor: '#1e293b',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#334155',
        marginBottom: 16,
    },
    channelHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    channelTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#fff',
    },
    channelFreqActive: {
        fontSize: 14,
        color: '#94a3b8',
    },
    leaveButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: '#ef4444',
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
    },
    leaveButtonText: {
        color: '#fff',
        fontWeight: 'bold',
    },
    userCountContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 4,
    },
    userCount: {
        fontSize: 14,
        color: '#94a3b8',
    },
    activeTransmissionsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 8,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: '#334155',
    },
    activeTransmissionsText: {
        fontSize: 14,
        color: '#ef4444',
        fontWeight: 'bold',
    },
    activityFeed: {
        padding: 16,
        backgroundColor: '#1e293b33',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#334155',
        marginBottom: 16,
        minHeight: 200,
    },
    activityTitleContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 12,
    },
    activityTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#94a3b8',
    },
    emptyActivity: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 32,
    },
    emptyText: {
        color: '#64748b',
        marginBottom: 4,
    },
    emptyHint: {
        fontSize: 12,
        color: '#475569',
    },
    messageItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        backgroundColor: '#33415533',
        borderRadius: 8,
        marginBottom: 8,
    },
    messageDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#22c55e',
        marginRight: 12,
    },
    messageDotSelf: {
        backgroundColor: '#3b82f6',
    },
    messageDotActive: {
        backgroundColor: '#ef4444',
    },
    messageContent: {
        flex: 1,
    },
    messageUser: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#fff',
    },
    messageTime: {
        fontSize: 12,
        color: '#94a3b8',
    },
    pttButton: {
        width: 180,
        height: 180,
        borderRadius: 90,
        backgroundColor: '#3b82f6',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#3b82f6',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 8,
    },
    pttButtonActive: {
        backgroundColor: '#ef4444',
        shadowColor: '#ef4444',
    },
    pttButtonDisabled: {
        backgroundColor: '#334155',
        opacity: 0.5,
    },
    pttText: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#fff',
        textAlign: 'center',
        marginTop: 8,
    },
    recordingIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 8,
    },
    recordingDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#fff',
        marginRight: 6,
    },
    recordingText: {
        fontSize: 12,
        color: '#fff',
        fontWeight: 'bold',
    },
    webrtcIndicator: {
        fontSize: 12,
        color: '#94a3b8',
        marginTop: 12,
    },
    statusBar: {
        padding: 12,
        backgroundColor: '#1e293b',
        borderTopWidth: 1,
        borderTopColor: '#334155',
    },
    statusBarContent: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
    },
    statusItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    statusText: {
        fontSize: 12,
        color: '#94a3b8',
    },
});