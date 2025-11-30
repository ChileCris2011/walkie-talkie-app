// app/(tabs)/index.tsx
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
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import io from 'socket.io-client';

// Usar FileSystem legacy para compatibilidad
const FileSystem = FileSystemLegacy;

// CONFIGURA TU SERVIDOR AQUÍ
// Para desarrollo local, reemplaza con tu IP local (ej: http://192.168.1.100:3000)
// Para producción, usa tu URL de servidor (ej: https://tu-servidor.railway.app)
const SERVER_URL = 'https://walkie-server-ov27.onrender.com'; // Por defecto

const CHANNELS = [
  { id: '1', name: 'Canal 1', frequency: '462.5625 MHz' },
  { id: '2', name: 'Canal 2', frequency: '462.5875 MHz' },
  { id: '3', name: 'Canal 3', frequency: '462.6125 MHz' },
  { id: '4', name: 'Canal 4', frequency: '462.6375 MHz' },
  { id: '5', name: 'Canal 5', frequency: '462.6625 MHz' },
];

class AudioService {
  recording: Audio.Recording | null = null;
  sound: Audio.Sound | null = null;
  beepSound: Audio.Sound | null = null;
  isRecording: boolean = false;
  recordingInterval: any = null;
  onAudioChunk: ((chunk: string) => void) | null = null;
  
  // Pre-cargar sonidos
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
      });

      // Pre-cargar sonidos para móvil
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
          console.log(`Sound files not found - using fallback (${e})`);
        }
      }

      return true;
    } catch (error) {
      console.error('Error initializing audio:', error);
      return false;
    }
  }

  async startRecording(onChunk?: (chunk: string) => void) {
    try {
      if (this.isRecording) return false;

      this.onAudioChunk = onChunk || null;
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
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 128000,
        }
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
    try {
      if (!this.isRecording || !this.recording) return null;

      if (this.recordingInterval) {
        clearInterval(this.recordingInterval);
        this.recordingInterval = null;
      }

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

  async getBase64Audio(uri: string) {
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
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return base64;
      }
    } catch (error) {
      console.error('Error reading audio file:', error);
      return null;
    }
  }

  // Reproducir sonido pre-cargado o generar beep
  async playBeepSound(type: 'push' | 'release' | 'incoming' | 'join' | 'leave') {
    if (Platform.OS === 'web') {
      // En web, generar tono sintético
      console.log(`Playing web beep`);
      this.playBeep(type);
    } else {
      // En móvil, reproducir sonido pre-cargado
      const sound = this.sounds[type];
      if (sound) {
        try {
          await sound.replayAsync();
          console.log(`Playing ${type}`);
        } catch (error) {
          console.log(`Could not play ${type} sound:`, error);
        }
      } else {
      	console.log(`Unknow error playing sound`);
      }
    }
  }

  // Generar tono sintético (beep) - Solo web
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
        // Secuencia de tonos
        config.sequence.forEach((freq, i) => {
          setTimeout(() => this.generateTone(audioContext, freq, 100), i * 150);
        });
      } else if (config.double) {
        // Doble beep
        this.generateTone(audioContext, config.frequency, config.duration);
        setTimeout(() => this.generateTone(audioContext, 1200, config.duration), 100);
      } else {
        // Tono simple
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
    if (this.recording) {
      this.recording.stopAndUnloadAsync();
    }
    if (this.sound) {
      this.sound.unloadAsync();
    }
    if (this.beepSound) {
      this.beepSound.unloadAsync();
    }
    // Limpiar sonidos pre-cargados
    Object.values(this.sounds).forEach(sound => {
      if (sound) sound.unloadAsync();
    });
    if (this.recordingInterval) {
      clearInterval(this.recordingInterval);
    }
  }
}

// Servicio de conexión Socket.io
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

    this.socket.on('audio-received', (data: any) => {
      console.log(`Audio received from ${data.userId}`);
      this.emit('audio-received', data);
    });

    this.socket.on('transmission-start', (data: any) => {
      this.emit('transmission-start', data);
    });

    this.socket.on('transmission-end', (data: any) => {
      this.emit('transmission-end', data);
    });

    return true;
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
    
    console.log(`Sending audio data (${audioData.length} bytes)`);
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

  const audioService = useRef(new AudioService());
  const connectionService = useRef(new ConnectionService());
  const transmissionTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    initializeApp();

    return () => {
      audioService.current.cleanup();
      connectionService.current.disconnect();
      deactivateKeepAwake();
    };
  }, []);

  const initializeApp = async () => {
    // Inicializar audio
    const audioInit = await audioService.current.initialize();
    setIsInitialized(audioInit);

    if (!audioInit) {
      Alert.alert(
        'Permisos Requeridos',
        'Esta app necesita acceso al micrófono para funcionar.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Conectar al servidor
    try {
      connectionService.current.connect(SERVER_URL);

      // Configurar listeners
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

      connectionService.current.on('user-joined', (joinedUserId: string) => {
        setChannelUsers((prev) => [...prev, joinedUserId]);
        playSound('join');
      });

      connectionService.current.on('user-left', (leftUserId: string) => {
        setChannelUsers((prev) => prev.filter((u) => u !== leftUserId));
      });

      connectionService.current.on('channel-users', (users: string[]) => {
        setChannelUsers(users);
      });

      connectionService.current.on('audio-received', async (data: any) => {
        if (!dndMode && !muteReceive) {
          addMessage(data.userId);
          playSound('incoming');

          // Reproducir audio recibido INMEDIATAMENTE
          if (data.audioData) {
            // No usar await aquí para que sea más rápido
            (async () => {
              try {
                if (Platform.OS === 'web') {
                  // En web, convertir base64 a blob y reproducir
                  const byteCharacters = atob(data.audioData);
                  const byteNumbers = new Array(byteCharacters.length);
                  for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                  }
                  const byteArray = new Uint8Array(byteNumbers);
                  const blob = new Blob([byteArray], { type: 'audio/webm' });
                  const audioUrl = URL.createObjectURL(blob);
                  
                  await audioService.current.playAudio(audioUrl);
                  
                  // Limpiar URL después de reproducir
                  setTimeout(() => URL.revokeObjectURL(audioUrl), 5000);
                } else {
                  // En móvil, convertir base64 a archivo temporal y reproducir
                  const tempUri = `${FileSystem.cacheDirectory}temp_audio_${Date.now()}.m4a`;
                  await FileSystem.writeAsStringAsync(tempUri, data.audioData, {
                    encoding: FileSystem.EncodingType.Base64,
                  });
                  await audioService.current.playAudio(tempUri);
                }
              } catch (error) {
                console.error('Error playing received audio:', error);
              }
            })();
          }
        }
      });

      connectionService.current.on('transmission-start', (data: any) => {
        console.log(`${data.userId} started transmitting`);
      });

      connectionService.current.on('transmission-end', (data: any) => {
        console.log(`${data.userId} stopped transmitting`);
      });

    } catch (error) {
      console.error('Failed to connect:', error);
      setConnectionError('No se pudo conectar al servidor');
    }
  };

  const playSound = (type: 'push' | 'release' | 'incoming' | 'join' | 'leave') => {
    console.log(dndMode ? 'DND on' : 'DND Off');
    if (dndMode) {
    	console.log('DND mode active, skiping sound');
    	return;
    }
    
    if (muteReceive && (type === 'incoming')) return;

    audioService.current.playBeepSound(type);

    if (Platform.OS !== 'web' && !dndMode) {
      try {
        if (type === 'push') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          Vibration.vibrate(100);
        } else if (type === 'release') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Vibration.vibrate(50);
        } else if (type === 'incoming') {
          if (!muteReceive) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Vibration.vibrate([100, 50, 100]);
          }
        } else if (type === 'join') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          Vibration.vibrate([100, 50, 100]);
        } else if (type === 'leave') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Vibration.vibrate([100, 50]);
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
        'No estás conectado al servidor. Verifica tu conexión a internet y que el servidor esté corriendo.'
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
    
    await activateKeepAwakeAsync();
  };

  const leaveChannel = () => {
    if (currentChannel) {
      connectionService.current.leaveChannel(currentChannel.id, userId);
      setCurrentChannel(null);
      setChannelUsers([]);
      setRecentMessages([]);
      playSound('leave');
      deactivateKeepAwake();
    }
  };

  const handlePushStart = async () => {
    if (!currentChannel || muteSend || isPushing) return;

    const success = await audioService.current.startRecording();
    if (success) {
      setIsPushing(true);
      setTransmissionTime(0);
      playSound('push');

      // Notificar inicio de transmisión
      connectionService.current.notifyTransmissionStart(currentChannel.id, userId);

      transmissionTimer.current = setInterval(() => {
        setTransmissionTime((prev) => prev + 0.1);
      }, 100);

      addMessage(userId);
    }
  };

  const handlePushEnd = async () => {
    if (!currentChannel || !isPushing) return;

    // Parar grabación
    const audioUri = await audioService.current.stopRecording();
    setIsPushing(false);
    playSound('release');

    if (transmissionTimer.current) {
      clearInterval(transmissionTimer.current);
      transmissionTimer.current = null;
    }

    // Notificar fin de transmisión
    connectionService.current.notifyTransmissionEnd(currentChannel.id, userId);

    if (audioUri) {
      console.log('Audio recorded:', audioUri);
      
      // Convertir y enviar audio inmediatamente (sin esperar)
      (async () => {
        try {
          const base64Audio = await audioService.current.getBase64Audio(audioUri);
          if (base64Audio) {
            connectionService.current.sendAudioData(currentChannel.id, userId, base64Audio);
            console.log('Audio sent successfully');
          }
        } catch (error) {
          console.error('Error sending audio:', error);
        }
      })();
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Walkie-Talkie</Text>
          <Text style={styles.headerSubtitle}>
            {isConnected ? '🟢 Conectado' : connectionError ? `🔴 ${connectionError}` : '🟡 Conectando...'}
          </Text>
        </View>

        <View style={styles.headerButtons}>
          <TouchableOpacity
            style={[styles.iconButton, dndMode && styles.iconButtonActive]}
            onPress={() => setDndMode(!dndMode)}
          >
            <Text style={styles.iconText}>{dndMode ? '🔕' : '🔔'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, muteReceive && styles.iconButtonActive]}
            onPress={() => setMuteReceive(!muteReceive)}
          >
            <Text style={styles.iconText}>{muteReceive ? '🔇' : '🔊'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, muteSend && styles.iconButtonActive]}
            onPress={() => setMuteSend(!muteSend)}
          >
            <Text style={styles.iconText}>{muteSend ? '🎤❌' : '🎤'}</Text>
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
                <Text style={styles.warningText}>
                  ⚠️ Permisos de micrófono requeridos
                </Text>
              </View>
            )}
            {!isConnected && (
              <View style={[styles.warningBox, { backgroundColor: '#ef4444' }]}>
                <Text style={styles.warningText}>
                  🔴 Sin conexión al servidor
                </Text>
                <Text style={[styles.warningText, { fontSize: 12, marginTop: 4 }]}>
                  Verifica que el servidor esté corriendo en: {SERVER_URL}
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
                <Text style={styles.channelIcon}>📻</Text>
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
                  <Text style={styles.leaveButtonText}>Salir</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.userCount}>
                👥 {channelUsers.length + 1} usuario(s) conectado(s)
              </Text>
            </View>

            {/* Activity Feed */}
            <View style={styles.activityFeed}>
              <Text style={styles.activityTitle}>Actividad Reciente</Text>
              {recentMessages.length === 0 ? (
                <View style={styles.emptyActivity}>
                  <Text style={styles.emptyIcon}>📻</Text>
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
                      <Text style={styles.messageIcon}>🔊</Text>
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
                <Text style={styles.pttIcon}>🎤</Text>
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
                    <Text style={styles.recordingText}>REC</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Status Bar */}
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>
          {dndMode ? '🔕 DND' : '🔔'} | {muteReceive ? '🔇' : '🔊'} | ID:{' '}
          {userId.slice(0, 8)}
        </Text>
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
  iconText: {
    fontSize: 20,
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
    marginBottom: 16,
  },
  warningBox: {
    padding: 12,
    backgroundColor: '#fbbf24',
    borderRadius: 8,
    marginBottom: 16,
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
  channelIcon: {
    fontSize: 24,
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
  },
  leaveButtonText: {
    color: '#fff',
    fontWeight: 'bold',
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
  activityTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#94a3b8',
    marginBottom: 12,
  },
  emptyActivity: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  emptyIcon: {
    fontSize: 48,
    opacity: 0.5,
    marginBottom: 8,
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
  messageIcon: {
    fontSize: 16,
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
  pttIcon: {
    fontSize: 64,
    marginBottom: 12,
  },
  pttText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
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
  statusText: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
  },
});
