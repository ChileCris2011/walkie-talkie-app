// App.js - Walkie-Talkie para Android
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
} from 'react-native';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import io from 'socket.io-client';

// Configurar notificaciones
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNELS = [
  { id: '1', name: 'Canal 1', frequency: '462.5625 MHz' },
  { id: '2', name: 'Canal 2', frequency: '462.5875 MHz' },
  { id: '3', name: 'Canal 3', frequency: '462.6125 MHz' },
  { id: '4', name: 'Canal 4', frequency: '462.6375 MHz' },
  { id: '5', name: 'Canal 5', frequency: '462.6625 MHz' },
];

// Servicio de Audio
class AudioService {
  constructor() {
    this.recording = null;
    this.sound = null;
    this.isRecording = false;
  }

  async initialize() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      return true;
    } catch (error) {
      console.error('Error initializing audio:', error);
      return false;
    }
  }

  async startRecording(onAudioData) {
    try {
      if (this.isRecording) return false;

      this.recording = new Audio.Recording();
      await this.recording.prepareToRecordAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_MPEG_4,
          audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.RECORDING_OPTION_IOS_OUTPUT_FORMAT_MPEG4AAC,
          audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_HIGH,
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
    try {
      if (!this.isRecording || !this.recording) return null;

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

  async playAudio(uri) {
    try {
      if (this.sound) {
        await this.sound.unloadAsync();
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true }
      );
      this.sound = sound;
      await sound.playAsync();
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  async playTone(frequency = 800, duration = 100) {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('./assets/beep.mp3'), // Necesitarás agregar un archivo de sonido
        { shouldPlay: true, volume: 0.5 }
      );
      setTimeout(() => sound.unloadAsync(), duration);
    } catch (error) {
      console.log('Tone playback not available');
    }
  }

  cleanup() {
    if (this.recording) {
      this.recording.stopAndUnloadAsync();
    }
    if (this.sound) {
      this.sound.unloadAsync();
    }
  }
}

// Servicio de conexión (simulado - reemplazar con servidor real)
class ConnectionService {
  constructor() {
    this.socket = null;
    this.channelId = null;
    this.userId = null;
    this.listeners = {};
  }

  connect(serverUrl = 'http://localhost:3000') {
    try {
      this.socket = io(serverUrl, {
        transports: ['websocket'],
        reconnection: true,
      });

      this.socket.on('connect', () => {
        console.log('Connected to server');
        this.emit('connected', true);
      });

      this.socket.on('user-joined', (userId) => {
        this.emit('user-joined', userId);
      });

      this.socket.on('user-left', (userId) => {
        this.emit('user-left', userId);
      });

      this.socket.on('audio-message', (data) => {
        this.emit('audio-received', data);
      });

      return true;
    } catch (error) {
      console.error('Connection error:', error);
      return false;
    }
  }

  joinChannel(channelId, userId) {
    this.channelId = channelId;
    this.userId = userId;
    if (this.socket) {
      this.socket.emit('join-channel', { channelId, userId });
    }
  }

  leaveChannel() {
    if (this.socket && this.channelId) {
      this.socket.emit('leave-channel', { channelId: this.channelId, userId: this.userId });
    }
    this.channelId = null;
  }

  sendAudio(audioUri) {
    if (this.socket && this.channelId) {
      // En producción, sube el audio a un servidor y envía la URL
      this.socket.emit('audio-message', {
        channelId: this.channelId,
        userId: this.userId,
        audioUri: audioUri,
        timestamp: Date.now(),
      });
    }
  }

  on(event, callback) {
    this.listeners[event] = callback;
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event](data);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

export default function App() {
  const [userId] = useState(`user_${Math.random().toString(36).substr(2, 9)}`);
  const [currentChannel, setCurrentChannel] = useState(null);
  const [isPushing, setIsPushing] = useState(false);
  const [dndMode, setDndMode] = useState(false);
  const [muteReceive, setMuteReceive] = useState(false);
  const [muteSend, setMuteSend] = useState(false);
  const [channelUsers, setChannelUsers] = useState([]);
  const [recentMessages, setRecentMessages] = useState([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [transmissionTime, setTransmissionTime] = useState(0);

  const audioService = useRef(new AudioService());
  const connectionService = useRef(new ConnectionService());
  const transmissionTimer = useRef(null);

  // Inicializar
  useEffect(() => {
    initializeApp();
    setupNotifications();

    return () => {
      audioService.current.cleanup();
      connectionService.current.disconnect();
      deactivateKeepAwake();
    };
  }, []);

  const initializeApp = async () => {
    const initialized = await audioService.current.initialize();
    setIsInitialized(initialized);

    if (initialized) {
      // Conectar al servidor (en desarrollo, esto fallará sin servidor)
      // connectionService.current.connect('https://walkie-server.railway.app/');
      
      // Configurar listeners
      connectionService.current.on('user-joined', (userId) => {
        setChannelUsers((prev) => [...prev, userId]);
      });

      connectionService.current.on('user-left', (userId) => {
        setChannelUsers((prev) => prev.filter((u) => u !== userId));
      });

      connectionService.current.on('audio-received', async (data) => {
        if (!dndMode && !muteReceive) {
          addMessage(data.userId);
          playSound('incoming');
          // Reproducir audio recibido
          if (data.audioUri) {
            await audioService.current.playAudio(data.audioUri);
          }
        }
      });
    }
  };

  const setupNotifications = async () => {
    await Notifications.requestPermissionsAsync();
  };

  const playSound = (type) => {
    if (dndMode && type === 'incoming') return;

    // Vibración
    if (type === 'push') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else if (type === 'release') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (type === 'incoming') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Vibration.vibrate([100, 50, 100]);
    }

    audioService.current.playTone();
  };

  const addMessage = (fromUserId) => {
    const msg = {
      userId: fromUserId,
      timestamp: Date.now(),
      type: 'audio',
    };
    setRecentMessages((prev) => [...prev, msg].slice(-10));
  };

  const joinChannel = async (channel) => {
    if (!isInitialized) {
      Alert.alert(
        'Error',
        'No se pudo inicializar el audio. Verifica los permisos de micrófono.'
      );
      return;
    }

    if (currentChannel) {
      connectionService.current.leaveChannel();
    }

    setCurrentChannel(channel);
    connectionService.current.joinChannel(channel.id, userId);
    playSound('join');
    setRecentMessages([]);
    
    // Mantener pantalla activa
    activateKeepAwakeAsync();
  };

  const leaveChannel = () => {
    if (currentChannel) {
      connectionService.current.leaveChannel();
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

      transmissionTimer.current = setInterval(() => {
        setTransmissionTime((prev) => prev + 0.1);
      }, 100);

      addMessage(userId);
    }
  };

  const handlePushEnd = async () => {
    if (!currentChannel || !isPushing) return;

    const audioUri = await audioService.current.stopRecording();
    setIsPushing(false);
    playSound('release');

    if (transmissionTimer.current) {
      clearInterval(transmissionTimer.current);
    }

    if (audioUri) {
      connectionService.current.sendAudio(audioUri);
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Walkie-Talkie</Text>
          <Text style={styles.headerSubtitle}>
            {isInitialized ? 'Listo' : 'Inicializando...'}
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
    flex: 1,
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
    flex: 1,
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
    fontFamily: 'monospace',
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
