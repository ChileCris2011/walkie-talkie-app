// app/index.tsx - Walkie-Talkie con WebRTC P2P
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
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import io from 'socket.io-client';
import { Ionicons } from '@expo/vector-icons';

// Import Audio only for mobile
let Audio: any = null;
let FileSystem: any = null;

if (Platform.OS !== 'web') {
  Audio = require('expo-av').Audio;
  FileSystem = require('expo-file-system/legacy');
}

// Para web: usar WebRTC nativo del navegador
// Para móvil: importar react-native-webrtc si está disponible
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;

if (Platform.OS === 'web') {
  RTCPeerConnection = window.RTCPeerConnection;
  RTCSessionDescription = window.RTCSessionDescription;
  RTCIceCandidate = window.RTCIceCandidate;
  mediaDevices = navigator.mediaDevices;
} else {
  try {
    const WebRTC = require('react-native-webrtc');
    RTCPeerConnection = WebRTC.RTCPeerConnection;
    RTCSessionDescription = WebRTC.RTCSessionDescription;
    RTCIceCandidate = WebRTC.RTCIceCandidate;
    mediaDevices = WebRTC.mediaDevices;
  } catch (e) {
    console.log('WebRTC not available on mobile, using fallback mode');
  }
}

// CONFIGURA TU SERVIDOR AQUÍ
const SERVER_URL = 'https://walkie-server-ov27.onrender.com/';

const CHANNELS = [
  { id: '1', name: 'Canal 1', frequency: '462.5625 MHz' },
  { id: '2', name: 'Canal 2', frequency: '462.5875 MHz' },
  { id: '3', name: 'Canal 3', frequency: '462.6125 MHz' },
  { id: '4', name: 'Canal 4', frequency: '462.6375 MHz' },
  { id: '5', name: 'Canal 5', frequency: '462.6625 MHz' },
];

// Configuración ICE para WebRTC
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

// ========== WEBRTC SERVICE ==========
class WebRTCService {
  peerConnections: Map<string, any> = new Map();
  localStream: any = null;
  onRemoteStream: ((userId: string, stream: any) => void) | null = null;
  onConnectionStateChange: ((userId: string, state: string) => void) | null = null;
  socket: any = null;
  userId: string = '';
  isWebRTCAvailable: boolean = false;

  constructor() {
    this.isWebRTCAvailable = !!RTCPeerConnection && !!mediaDevices;
  }

  setSocket(socket: any, userId: string) {
    this.socket = socket;
    this.userId = userId;
  }

  async initializeLocalStream() {
    if (!this.isWebRTCAvailable) {
      console.log('WebRTC not available');
      return false;
    }

    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
        video: false
      };

      this.localStream = await mediaDevices.getUserMedia(constraints);
      console.log('Local stream initialized:', this.localStream.id);
      return true;
    } catch (error) {
      console.error('Error getting local stream:', error);
      return false;
    }
  }

  async createPeerConnection(remoteUserId: string, remoteSocketId: string, isInitiator: boolean) {
    if (!this.isWebRTCAvailable || !this.localStream) {
      console.log('Cannot create peer connection: WebRTC not available or no local stream');
      return null;
    }

    try {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      
      // Add local stream tracks
      if (this.localStream.getTracks) {
        this.localStream.getTracks().forEach((track: any) => {
          pc.addTrack(track, this.localStream);
        });
      }

      // Handle ICE candidates
      pc.onicecandidate = (event: any) => {
        if (event.candidate && this.socket) {
          console.log(`Sending ICE candidate to ${remoteUserId}`);
          this.socket.emit('ice-candidate', {
            to: remoteSocketId,
            from: this.userId,
            candidate: event.candidate
          });
        }
      };

      // Handle remote stream
      pc.ontrack = (event: any) => {
        console.log(`Received remote track from ${remoteUserId}`);
        if (event.streams && event.streams[0]) {
          if (this.onRemoteStream) {
            this.onRemoteStream(remoteUserId, event.streams[0]);
          }
        }
      };

      // Handle connection state
      pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${remoteUserId}: ${pc.connectionState}`);
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(remoteUserId, pc.connectionState);
        }

        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.removePeerConnection(remoteUserId);
        }
      };

      // Handle ICE connection state
      pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${remoteUserId}: ${pc.iceConnectionState}`);
      };

      this.peerConnections.set(remoteUserId, {
        connection: pc,
        socketId: remoteSocketId
      });

      // If initiator, create offer
      if (isInitiator) {
        await this.createOffer(remoteUserId, remoteSocketId);
      }

      return pc;
    } catch (error) {
      console.error('Error creating peer connection:', error);
      return null;
    }
  }

  async createOffer(remoteUserId: string, remoteSocketId: string) {
    const peerData = this.peerConnections.get(remoteUserId);
    if (!peerData) return;

    try {
      const offer = await peerData.connection.createOffer();
      await peerData.connection.setLocalDescription(offer);

      if (this.socket) {
        console.log(`Sending offer to ${remoteUserId}`);
        this.socket.emit('webrtc-offer', {
          to: remoteSocketId,
          from: this.userId,
          offer: offer
        });
      }
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }

  async handleOffer(fromUserId: string, fromSocketId: string, offer: any) {
    console.log(`Handling offer from ${fromUserId}`);
    
    let peerData = this.peerConnections.get(fromUserId);
    
    if (!peerData) {
      await this.createPeerConnection(fromUserId, fromSocketId, false);
      peerData = this.peerConnections.get(fromUserId);
    }

    if (!peerData) return;

    try {
      await peerData.connection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerData.connection.createAnswer();
      await peerData.connection.setLocalDescription(answer);

      if (this.socket) {
        console.log(`Sending answer to ${fromUserId}`);
        this.socket.emit('webrtc-answer', {
          to: fromSocketId,
          from: this.userId,
          answer: answer
        });
      }
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  async handleAnswer(fromUserId: string, answer: any) {
    console.log(`Handling answer from ${fromUserId}`);
    const peerData = this.peerConnections.get(fromUserId);
    
    if (!peerData) return;

    try {
      await peerData.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }

  async handleIceCandidate(fromUserId: string, candidate: any) {
    const peerData = this.peerConnections.get(fromUserId);
    
    if (!peerData) {
      console.log(`No peer connection for ${fromUserId}, ignoring ICE candidate`);
      return;
    }

    try {
      await peerData.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  }

  removePeerConnection(userId: string) {
    const peerData = this.peerConnections.get(userId);
    if (peerData) {
      peerData.connection.close();
      this.peerConnections.delete(userId);
      console.log(`Removed peer connection for ${userId}`);
    }
  }

  async muteAudio(muted: boolean) {
    if (this.localStream && this.localStream.getAudioTracks) {
      this.localStream.getAudioTracks().forEach((track: any) => {
        track.enabled = !muted;
      });
    }
  }

  cleanup() {
    // Stop local stream
    if (this.localStream && this.localStream.getTracks) {
      this.localStream.getTracks().forEach((track: any) => track.stop());
    }

    // Close all peer connections
    this.peerConnections.forEach((peerData) => {
      peerData.connection.close();
    });
    this.peerConnections.clear();
  }
}

// ========== AUDIO SERVICE (Fallback) ==========
class AudioService {
  recording: any = null;
  sound: any = null;
  beepSound: any = null;
  isRecording: boolean = false;
  mediaRecorder: any = null;
  audioChunks: any[] = [];
  
  sounds: {
    push?: any;
    release?: any;
    incoming?: any;
    join?: any;
    leave?: any;
    silence?: any;
  } = {};

  async initialize() {
    // En web, no necesitamos expo-av, usamos Web APIs
    if (Platform.OS === 'web') {
      try {
        // Verificar permisos de micrófono
        await navigator.mediaDevices.getUserMedia({ audio: true });
        return true;
      } catch (error) {
        console.error('Error initializing web audio:', error);
        return false;
      }
    }
    
    // En móvil, usar expo-av
    if (!Audio) {
      console.error('Audio module not available');
      return false;
    }
    
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
      });
      
      if (Platform.OS !== 'web') {
        try {
          const soundFiles = {
            push: require('../assets/sounds/push.m4a'),
            release: require('../assets/sounds/release.wav'),
            incoming: require('../assets/sounds/incoming.wav'),
            join: require('../assets/sounds/join.wav'),
            leave: require('../assets/sounds/leave.wav'),
            silence: require('../assets/sounds/silence.wav'),
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
          console.log(`Sound files not found - using fallback (${e})`);
        }
      }

      return true;
    } catch (error) {
      console.error('Error initializing audio:', error);
      return false;
    }
  }

  async startRecording() {
    if (this.isRecording) return false;

    // Web: usar MediaRecorder API
    if (Platform.OS === 'web') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(stream);
        this.audioChunks = [];

        this.mediaRecorder.ondataavailable = (event: any) => {
          if (event.data.size > 0) {
            this.audioChunks.push(event.data);
          }
        };

        this.mediaRecorder.start();
        this.isRecording = true;
        return true;
      } catch (error) {
        console.error('Error starting web recording:', error);
        return false;
      }
    }

    // Móvil: usar expo-av
    if (!Audio) return false;

    try {
      this.recording = new Audio.Recording();
      
      await this.recording.prepareToRecordAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
      });

      await this.recording.startAsync();
      this.isRecording = true;
      return true;
    } catch (error) {
      console.error('Error starting recording:', error);
      return false;
    }
  }

  async stopRecording() {
    if (!this.isRecording) return null;

    // Web: detener MediaRecorder
    if (Platform.OS === 'web') {
      return new Promise((resolve) => {
        if (!this.mediaRecorder) {
          resolve(null);
          return;
        }

        this.mediaRecorder.onstop = () => {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          const audioUrl = URL.createObjectURL(audioBlob);
          this.isRecording = false;
          this.mediaRecorder = null;
          resolve(audioUrl);
        };

        this.mediaRecorder.stop();
        
        // Stop all tracks
        if (this.mediaRecorder.stream) {
          this.mediaRecorder.stream.getTracks().forEach((track: any) => track.stop());
        }
      });
    }

    // Móvil: usar expo-av
    if (!this.recording) return null;

    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.isRecording = false;
      this.recording = null;
      return uri;
    } catch (error) {
      console.error('Error stopping recording:', error);
      return null;
    }
  }

  async playAudio(uri: string) {
    // Web: usar HTMLAudioElement
    if (Platform.OS === 'web') {
      try {
        const audio = new window.Audio(uri);
        audio.play();
        return;
      } catch (error) {
        console.error('Error playing web audio:', error);
      }
    }

    // Móvil: usar expo-av
    if (!Audio) return;

    try {
      if (this.sound) {
        await this.sound.unloadAsync();
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 }
      );
      this.sound = sound;
      await sound.playAsync();
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }
  
  async playBeepSound(type: 'push' | 'release' | 'incoming' | 'join' | 'leave' | 'silence') {
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

  playBeep(type: 'push' | 'release' | 'incoming' | 'join' | 'leave' | 'silence') {
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
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration / 1000);
  }

  cleanup() {
    if (Platform.OS === 'web') {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
        if (this.mediaRecorder.stream) {
          this.mediaRecorder.stream.getTracks().forEach((track: any) => track.stop());
        }
      }
    } else {
      if (this.recording) {
        this.recording.stopAndUnloadAsync();
      }
      if (this.sound) {
        this.sound.unloadAsync();
      }
      if (this.beepSound) {
        this.beepSound.unloadAsync();
      }
    }
  }
}

// ========== CONNECTION SERVICE ==========
class ConnectionService {
  socket: any = null;
  isConnected: boolean = false;
  serverUrl: string = '';
  listeners: { [key: string]: (data: any) => void } = {};

  connect(serverUrl: string) {
    this.serverUrl = serverUrl;
    
    console.log(`Connecting to ${serverUrl}...`);
    
    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
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

    this.socket.on('user-joined', (data: any) => {
      console.log(`User joined:`, data);
      this.emit('user-joined', data);
    });

    this.socket.on('user-left', (data: any) => {
      console.log(`User left:`, data);
      this.emit('user-left', data);
    });

    this.socket.on('channel-users', (users: any[]) => {
      console.log(`Channel users:`, users);
      this.emit('channel-users', users);
    });

    // WebRTC signaling events
    this.socket.on('webrtc-offer', (data: any) => {
      this.emit('webrtc-offer', data);
    });

    this.socket.on('webrtc-answer', (data: any) => {
      this.emit('webrtc-answer', data);
    });

    this.socket.on('ice-candidate', (data: any) => {
      this.emit('ice-candidate', data);
    });

    // Fallback audio events
    this.socket.on('audio-received', (data: any) => {
      console.log(`Audio received from ${data.userId} (fallback)`);
      this.emit('audio-received', data);
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

  sendAudioData(channelId: string, userId: string, audioData: string) {
    if (!this.socket || !this.isConnected) return false;
    
    console.log(`Sending audio data (fallback mode)`);
    this.socket.emit('audio-data', {
      channelId,
      userId,
      audioData,
      timestamp: Date.now(),
    });
    return true;
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
}

// ========== MAIN COMPONENT ==========
export default function WalkieTalkieScreen() {
  const [userId] = useState(`user_${Math.random().toString(36).substr(2, 9)}`);
  const [currentChannel, setCurrentChannel] = useState<typeof CHANNELS[0] | null>(null);
  const [isPushing, setIsPushing] = useState(false);
  const [dndMode, setDndMode] = useState(false);
  const [muteReceive, setMuteReceive] = useState(false);
  const [muteSend, setMuteSend] = useState(false);
  const [channelUsers, setChannelUsers] = useState<any[]>([]);
  const [recentMessages, setRecentMessages] = useState<any[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [transmissionTime, setTransmissionTime] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [useWebRTC, setUseWebRTC] = useState(true);
  const [webRTCStatus, setWebRTCStatus] = useState<string>('Initializing...');

  const dndModeRef = useRef(dndMode);
  const muteReceiveRef = useRef(muteReceive);
  const muteSendRef = useRef(muteSend);
  
  const webrtcService = useRef(new WebRTCService());
  const audioService = useRef(new AudioService());
  const connectionService = useRef(new ConnectionService());
  const transmissionTimer = useRef<NodeJS.Timeout | null>(null);
  const remoteAudioElements = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    dndModeRef.current = dndMode;
  }, [dndMode]);

  useEffect(() => {
    muteReceiveRef.current = muteReceive;
  }, [muteReceive]);

  useEffect(() => {
    muteSendRef.current = muteSend;
  }, [muteSend]);

  useEffect(() => {
    initializeApp();

    return () => {
      webrtcService.current.cleanup();
      audioService.current.cleanup();
      connectionService.current.disconnect();
      deactivateKeepAwake();
    };
  }, []);
  
  function someRepeated() {
    if (Platform.OS !== 'web') {
      console.log('Silence');
      playSound('silence');
    }
  }

  const initializeApp = async () => {
    // Initialize audio service (for fallback)
    const audioInit = await audioService.current.initialize();
    
    // Initialize WebRTC if available
    let webRTCInit = false;
    if (webrtcService.current.isWebRTCAvailable) {
      webRTCInit = await webrtcService.current.initializeLocalStream();
      if (webRTCInit) {
        setWebRTCStatus('WebRTC Ready ✓');
        setUseWebRTC(true);
      } else {
        setWebRTCStatus('WebRTC Failed - Using Fallback');
        setUseWebRTC(false);
      }
    } else {
      setWebRTCStatus('WebRTC Not Available - Using Fallback');
      setUseWebRTC(false);
    }

    setIsInitialized(audioInit);

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
      webrtcService.current.setSocket(socket, userId);

      // Setup WebRTC callbacks
      webrtcService.current.onRemoteStream = (remoteUserId: string, stream: any) => {
        console.log(`Playing remote stream from ${remoteUserId}`);
        playRemoteStream(remoteUserId, stream);
      };

      webrtcService.current.onConnectionStateChange = (remoteUserId: string, state: string) => {
        console.log(`Connection with ${remoteUserId}: ${state}`);
      };

      connectionService.current.on('connection-status', (connected: boolean) => {
        setIsConnected(connected);
        if (connected) {
          setConnectionError(null);
        }
      });

      connectionService.current.on('connection-error', (error: string) => {
        setConnectionError(error);
        console.error('Connection error:', error);
      });

      connectionService.current.on('user-joined', async (data: any) => {
        const { userId: joinedUserId, socketId } = data;
        
        setChannelUsers((prev) => {
          if (prev.find(u => u.userId === joinedUserId)) return prev;
          return [...prev, { userId: joinedUserId, socketId }];
        });
        
        playSound('join');

        // If WebRTC is enabled, create peer connection as initiator
        if (useWebRTC && webrtcService.current.localStream) {
          console.log(`Creating peer connection with ${joinedUserId} (initiator)`);
          await webrtcService.current.createPeerConnection(joinedUserId, socketId, true);
        }
        
      });

      connectionService.current.on('user-left', (data: any) => {
        const { userId: leftUserId } = data;
        
        setChannelUsers((prev) => prev.filter((u) => u.userId !== leftUserId));
        webrtcService.current.removePeerConnection(leftUserId);
        
        // Stop remote audio
        const audioElement = remoteAudioElements.current.get(leftUserId);
        if (audioElement && Platform.OS === 'web') {
          audioElement.pause();
          audioElement.srcObject = null;
          remoteAudioElements.current.delete(leftUserId);
        }
      });

      connectionService.current.on('channel-users', async (users: any[]) => {
        setChannelUsers(users);

        // Create peer connections with existing users
        if (useWebRTC && webrtcService.current.localStream) {
          for (const user of users) {
            if (user.userId !== userId) {
              console.log(`Creating peer connection with existing user ${user.userId}`);
              await webrtcService.current.createPeerConnection(user.userId, user.socketId, false);
            }
          }
        }
      });

      // WebRTC signaling handlers
      connectionService.current.on('webrtc-offer', async (data: any) => {
        const { from, fromUserId, offer } = data;
        console.log(`Received offer from ${fromUserId}`);
        await webrtcService.current.handleOffer(fromUserId, from, offer);
      });

      connectionService.current.on('webrtc-answer', async (data: any) => {
        const { fromUserId, answer } = data;
        console.log(`Received answer from ${fromUserId}`);
        await webrtcService.current.handleAnswer(fromUserId, answer);
      });

      connectionService.current.on('ice-candidate', async (data: any) => {
        const { fromUserId, candidate } = data;
        await webrtcService.current.handleIceCandidate(fromUserId, candidate);
      });

      // Fallback audio handler
      connectionService.current.on('audio-received', async (data: any) => {
        const isDND = dndModeRef.current;
        const isMuted = muteReceiveRef.current;
        
        if (!isDND && !isMuted) {
          addMessage(data.userId);
          playSound('incoming');

          if (data.audioData) {
            try {
              if (Platform.OS === 'web') {
                const byteCharacters = atob(data.audioData);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'audio/webm' });
                const audioUrl = URL.createObjectURL(blob);
                
                await audioService.current.playAudio(audioUrl);
                setTimeout(() => URL.revokeObjectURL(audioUrl), 5000);
              } else {
                if (!FileSystem) {
                  console.error('FileSystem not available');
                  return;
                }
                const tempUri = `${FileSystem.cacheDirectory}temp_audio_${Date.now()}.m4a`;
                await FileSystem.writeAsStringAsync(tempUri, data.audioData, {
                  encoding: FileSystem.EncodingType.Base64,
                });
                await audioService.current.playAudio(tempUri);
              }
            } catch (error) {
              console.error('Error playing received audio:', error);
            }
          }
        }
      });

      connectionService.current.on('transmission-start', (data: any) => {
        console.log(`${data.userId} started transmitting`);
        addMessage(data.userId);
        playSound('incoming');
      });

    } catch (error) {
      console.error('Failed to initialize:', error);
      setConnectionError('No se pudo conectar al servidor');
    }
  };

  const playRemoteStream = (userId: string, stream: any) => {
    if (Platform.OS === 'web') {
      let audioElement = remoteAudioElements.current.get(userId);
      
      if (!audioElement) {
        audioElement = new window.Audio();
        audioElement.autoplay = true;
        remoteAudioElements.current.set(userId, audioElement);
      }
      
      audioElement.srcObject = stream;
      audioElement.play().catch((e: any) => console.error('Error playing remote audio:', e));
    }
    // Para móvil, react-native-webrtc maneja la reproducción automáticamente
  };

  const playSound = (type: 'push' | 'release' | 'incoming' | 'join' | 'leave' | 'silence') => {
    const isDND = dndModeRef.current;
    
    if (isDND && type !== 'push' && type !== 'release') return;

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
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Vibration.vibrate([100, 50, 100]);
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
    }

    setCurrentChannel(channel);
    connectionService.current.joinChannel(channel.id, userId);
    playSound('join');
    setRecentMessages([]);
    
    let timeoutId = setInterval(someRepeated, 3000);
    
    if (useWebRTC) {
      await webrtcService.current.muteAudio(true);
    }
    
    await activateKeepAwakeAsync();
  };

  const leaveChannel = () => {
    if (currentChannel) {
      connectionService.current.leaveChannel(currentChannel.id, userId);
      
      // Clean up peer connections
      channelUsers.forEach(user => {
        webrtcService.current.removePeerConnection(user.userId);
      });
      
      setCurrentChannel(null);
      setChannelUsers([]);
      setRecentMessages([]);
      playSound('leave');
      clearInterval(timeoutId);
      deactivateKeepAwake();
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

    // Unmute audio in WebRTC
    if (useWebRTC) {
      await webrtcService.current.muteAudio(false);
    } else {
      // Start recording for fallback mode
      await audioService.current.startRecording();
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

    // Mute audio in WebRTC
    if (useWebRTC) {
      await webrtcService.current.muteAudio(true);
    } else {
      // Stop recording and send audio (fallback mode)
      const audioUri = await audioService.current.stopRecording();
      if (audioUri) {
        try {
          const base64Audio = await getBase64Audio(audioUri);
          if (base64Audio) {
            connectionService.current.sendAudioData(currentChannel.id, userId, base64Audio);
          }
        } catch (error) {
          console.error('Error sending audio:', error);
        }
      }
    }
  };

  const getBase64Audio = async (uri: string) => {
    try {
      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        const blob = await response.blob();
        
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        if (!FileSystem) {
          console.error('FileSystem not available');
          return null;
        }
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return base64;
      }
    } catch (error) {
      console.error('Error reading audio file:', error);
      return null;
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Walkie-Talkie</Text>
          <View style={styles.statusRow}>
            <Ionicons 
              name={isConnected ? 'checkmark-circle' : connectionError ? 'close-circle' : 'alert-circle'} 
              size={14} 
              color={isConnected ? '#22c55e' : '#ef4444'} 
            />
            <Text style={styles.headerSubtitle}>
              {isConnected ? 'Conectado' : connectionError || 'Conectando...'}
            </Text>
          </View>
          <Text style={[styles.webrtcStatus, { color: useWebRTC ? '#22c55e' : '#fbbf24' }]}>
            {webRTCStatus}
          </Text>
        </View>

        <View style={styles.headerButtons}>
          <TouchableOpacity
            style={[styles.iconButton, dndMode && styles.iconButtonActive]}
            onPress={() => setDndMode(!dndMode)}
          >
            <Ionicons 
              name={dndMode ? "notifications-off" : "notifications"} 
              size={20} 
              color="#fff" 
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, muteReceive && styles.iconButtonActive]}
            onPress={() => {
              setMuteReceive(!muteReceive);
              // Note: WebRTC streams are handled by remote audio elements
            }}
          >
            <Ionicons 
              name={muteReceive ? "volume-mute" : "volume-high"} 
              size={20} 
              color="#fff" 
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, muteSend && styles.iconButtonActive]}
            onPress={() => setMuteSend(!muteSend)}
          >
            <Ionicons 
              name={muteSend ? "mic-off" : "mic"} 
              size={20} 
              color="#fff" 
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content */}
      <ScrollView style={styles.content}>
        {!currentChannel ? (
          <View style={styles.channelList}>
            <Text style={styles.sectionTitle}>Selecciona un Canal</Text>
            {!isInitialized && (
              <View style={styles.warningBox}>
                <Ionicons name="warning" size={14} color="#000" />
                <Text style={styles.warningText}>
                  Permisos de micrófono requeridos
                </Text>
              </View>
            )}
            {!isConnected && (
              <View style={[styles.warningBox, { backgroundColor: '#ef4444' }]}>
                <Ionicons name="close-circle" size={14} color="#fff" />
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
                disabled={!isInitialized || !isConnected}
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
                  <Text style={styles.channelMode}>
                    Modo: {useWebRTC ? 'WebRTC P2P' : 'Relay'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.leaveButton}
                  onPress={leaveChannel}
                >
                  <Ionicons name="exit-outline" size={18} color="#fff" />
                  <Text style={styles.leaveButtonText}>Salir</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.userCountContainer}>
                <Ionicons name="people" size={14} color="#94a3b8" />
                <Text style={styles.userCount}>
                  {channelUsers.length + 1} usuario(s) conectado(s)
                </Text>
              </View>
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
                      <Ionicons name="volume-high" size={16} color="#3b82f6" />
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
                <Ionicons name="mic" size={64} color="#fff" />
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
                    <Text style={styles.recordingText}>
                      {useWebRTC ? 'LIVE' : 'REC'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Status Bar */}
      <View style={styles.statusBar}>
        <View style={styles.statusBarContent}>
          <View style={styles.statusItem}>
            <Ionicons 
              name={useWebRTC ? "flash" : "cloud-upload"} 
              size={12} 
              color={useWebRTC ? "#22c55e" : "#fbbf24"} 
            />
            <Text style={styles.statusText}>
              {useWebRTC ? 'P2P' : 'Relay'}
            </Text>
          </View>
          
          <View style={styles.statusItem}>
            <Ionicons 
              name={dndMode ? "notifications-off" : "notifications"} 
              size={12} 
              color={dndMode ? "#ef4444" : "#94a3b8"} 
            />
          </View>
          
          <View style={styles.statusItem}>
            <Ionicons name="finger-print" size={12} color="#94a3b8" />
            <Text style={styles.statusText}>
              {userId.slice(0, 8)}
            </Text>
          </View>
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
  },
  webrtcStatus: {
    fontSize: 10,
    marginTop: 2,
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
    marginBottom: 8,
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
  channelMode: {
    fontSize: 12,
    color: '#22c55e',
    marginTop: 4,
  },
  leaveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#ef4444',
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  leaveButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  userCountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  userCount: {
    fontSize: 14,
    color: '#94a3b8',
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
  pttContainer: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  transmissionTime: {
    fontSize: 14,
    color: '#94a3b8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginBottom: 8,
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
