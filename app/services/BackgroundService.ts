// app/services/BackgroundService.ts
import { Platform } from 'react-native';

// Importaciones condicionales
let BackgroundService: any = null;
let notifee: any = null;

if (Platform.OS !== 'web') {
    try {
        BackgroundService = require('react-native-background-actions').default;
        notifee = require('@notifee/react-native').default;
    } catch (e) {
        console.log('Background services not available');
    }
}

export class WalkieTalkieBackgroundService {
    static isRunning = false;
    static channelId = 'walkie-talkie-channel';
    static currentTask: any = null;

    static async initialize() {
        if (Platform.OS === 'web' || !notifee) return;

        try {
            if (Platform.OS === 'android') {
                const AndroidImportance = notifee.AndroidImportance || { HIGH: 4 };

                await notifee.createChannel({
                    id: this.channelId,
                    name: 'Walkie-Talkie Service',
                    importance: AndroidImportance.HIGH,
                    sound: 'default',
                    vibration: true,
                });

                console.log('Notification channel created');
            }
        } catch (error) {
            console.error('Error initializing background service:', error);
        }
    }

    static async start(channelName: string, userId: string) {
        if (Platform.OS === 'web' || !BackgroundService) {
            console.log('Background service not available on web');
            return;
        }

        if (this.isRunning) {
            console.log('Background service already running');
            return;
        }

        try {
            const options = {
                taskName: 'Walkie-Talkie',
                taskTitle: '🎙️ Walkie-Talkie Activo',
                taskDesc: `Conectado a ${channelName}`,
                taskIcon: {
                    name: 'ic_launcher',
                    type: 'mipmap',
                },
                color: '#3b82f6',
                linkingURI: 'walkietalkie://channel',
                progressBar: {
                    max: 100,
                    value: 0,
                    indeterminate: true,
                },
                parameters: {
                    delay: 1000,
                    channelName,
                    userId,
                },
            };

            const backgroundTask = async (taskDataArguments: any) => {
                const { delay, channelName } = taskDataArguments;
                let counter = 0;

                await new Promise(async (resolve) => {
                    while (BackgroundService.isRunning()) {
                        counter++;

                        // Actualizar notificación cada 30 segundos
                        if (counter % 30 === 0) {
                            const minutes = Math.floor(counter / 60);
                            const hours = Math.floor(minutes / 60);
                            const remainingMinutes = minutes % 60;

                            let timeStr = '';
                            if (hours > 0) {
                                timeStr = `${hours}h ${remainingMinutes}m`;
                            } else {
                                timeStr = `${minutes}m`;
                            }

                            await BackgroundService.updateNotification({
                                taskTitle: '🎙️ Walkie-Talkie Activo',
                                taskDesc: `${channelName} - Activo ${timeStr}`,
                                progressBar: {
                                    max: 100,
                                    value: (counter % 100),
                                    indeterminate: false,
                                },
                            });
                        }

                        // Sleep para no consumir CPU
                        await new Promise(r => setTimeout(r, delay));
                    }
                    resolve(null);
                });
            };

            await BackgroundService.start(backgroundTask, options);
            this.isRunning = true;
            console.log('Background service started');
        } catch (error) {
            console.error('Error starting background service:', error);
        }
    }

    static async stop() {
        if (Platform.OS === 'web' || !BackgroundService) return;
        if (!this.isRunning) return;

        try {
            await BackgroundService.stop();
            this.isRunning = false;
            console.log('Background service stopped');
        } catch (error) {
            console.error('Error stopping background service:', error);
        }
    }

    static async updateNotification(title: string, message: string) {
        if (Platform.OS === 'web' || !BackgroundService) return;
        if (!this.isRunning) return;

        try {
            await BackgroundService.updateNotification({
                taskTitle: title,
                taskDesc: message,
            });
        } catch (error) {
            console.error('Error updating notification:', error);
        }
    }

    static async showNotification(title: string, body: string, data?: any) {
        if (Platform.OS === 'web' || !notifee) return;

        try {
            await notifee.displayNotification({
                title,
                body,
                data,
                android: {
                    channelId: this.channelId,
                    importance: 4, // HIGH
                    smallIcon: 'ic_launcher',
                    color: '#3b82f6',
                    pressAction: {
                        id: 'default',
                        launchActivity: 'default',
                    },
                    sound: 'default',
                    vibrationPattern: [300, 500],
                },
                ios: {
                    sound: 'default',
                    critical: false,
                    foregroundPresentationOptions: {
                        badge: true,
                        sound: true,
                        banner: true,
                        list: true,
                    },
                },
            });
        } catch (error) {
            console.error('Error showing notification:', error);
        }
    }

    static async showTransmissionNotification(userId: string, isOwn: boolean) {
        if (Platform.OS === 'web') return;

        const title = isOwn ? '📤 Transmitiendo' : '📥 Mensaje recibido';
        const body = isOwn
            ? 'Estás transmitiendo audio'
            : `Transmisión de ${userId}`;

        await this.showNotification(title, body, {
            type: 'transmission',
            userId,
            timestamp: Date.now(),
        });
    }

    static getIsRunning(): boolean {
        return this.isRunning;
    }
}

// Función auxiliar para verificar disponibilidad
export function isBackgroundServiceAvailable(): boolean {
    return Platform.OS !== 'web' && BackgroundService !== null;
}