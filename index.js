require("dotenv").config();

const fs = require("fs");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

/*
 * @discordjs/voice, MP3 dosyasını oynatırken
 * kurduğumuz ffmpeg-static paketini kullanacak.
 */
if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
}

const {
    Client,
    Events,
    GatewayIntentBits,
} = require("discord.js");

const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
} = require("@discordjs/voice");

const AUDIO_FILE = path.resolve(
    __dirname,
    process.env.AUDIO_FILE || "./audio/welcome.mp3"
);

/*
 * Ses seviyesi:
 * 0.25 = yüzde 25
 * Kayıt sırasında konuşmaları bastırmaması için düşük tutuldu.
 */
const AUDIO_VOLUME = 0.1;

const BOT_CONFIGS = [
    {
        key: "welcome-1",
        label: "Welcome to Çay Ocağı I",
        token: process.env.WELCOME_1_TOKEN,
        channelId: process.env.WELCOME_1_CHANNEL_ID,
    },
    {
        key: "welcome-2",
        label: "Welcome to Çay Ocağı II",
        token: process.env.WELCOME_2_TOKEN,
        channelId: process.env.WELCOME_2_CHANNEL_ID,
    },
    {
        key: "welcome-3",
        label: "Welcome to Çay Ocağı III",
        token: process.env.WELCOME_3_TOKEN,
        channelId: process.env.WELCOME_3_CHANNEL_ID,
    },
];

const runtimes = [];

function validateSettings() {
    if (!ffmpegPath) {
        console.error(
            "❌ ffmpeg-static bu bilgisayar için uygun bir FFmpeg dosyası bulamadı."
        );

        process.exit(1);
    }

    if (!fs.existsSync(AUDIO_FILE)) {
        console.error("❌ Karşılama müziği bulunamadı.");
        console.error(`Aranan dosya: ${AUDIO_FILE}`);
        console.error(
            "MP3 dosyasının audio klasöründe ve adının welcome.mp3 olduğundan emin ol."
        );

        process.exit(1);
    }

    const missingSettings = [];

    for (const config of BOT_CONFIGS) {
        if (!config.token) {
            missingSettings.push(`${config.key} token`);
        }

        if (!config.channelId) {
            missingSettings.push(`${config.key} kanal ID`);
        }
    }

    if (missingSettings.length > 0) {
        console.error("❌ .env dosyasında eksik ayar var:");

        for (const setting of missingSettings) {
            console.error(`- ${setting}`);
        }

        process.exit(1);
    }

    const channelIds = BOT_CONFIGS.map(
        config => config.channelId
    );

    const uniqueChannelIds = new Set(channelIds);

    if (uniqueChannelIds.size !== BOT_CONFIGS.length) {
        console.error(
            "❌ Üç bot için birbirinden farklı üç ses kanalı kimliği kullanılmalı."
        );

        process.exit(1);
    }
}

function getHumanCount(channel) {
    if (!channel || !channel.members) {
        return 0;
    }

    return channel.members.filter(
        member => !member.user.bot
    ).size;
}

function playWelcomeMusic(runtime) {
    try {
        const resource = createAudioResource(
            AUDIO_FILE,
            {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
            }
        );

        if (resource.volume) {
            resource.volume.setVolume(
                AUDIO_VOLUME
            );
        }

        /*
         * Müzik zaten çalıyorsa yeni üye girdiğinde
         * dosya baştan başlatılır.
         */
        runtime.player.play(resource);

        console.log(
            `🎵 ${runtime.config.label}: Karşılama müziği başladı.`
        );
    } catch (error) {
        console.error(
            `❌ ${runtime.config.label}: Müzik başlatılamadı.`
        );

        console.error(error);
    }
}

function stopWelcomeMusic(runtime) {
    if (
        runtime.player.state.status ===
        AudioPlayerStatus.Idle
    ) {
        return;
    }

    runtime.player.stop(true);

    console.log(
        `⏹️ ${runtime.config.label}: Oda boşaldı, müzik durduruldu.`
    );
}

function scheduleReconnect(
    runtime,
    delay = 5000
) {
    if (runtime.shuttingDown) {
        return;
    }

    if (runtime.reconnectTimer) {
        clearTimeout(
            runtime.reconnectTimer
        );
    }

    runtime.reconnectTimer = setTimeout(
        () => {
            runtime.reconnectTimer = null;

            connectToConfiguredChannel(
                runtime
            ).catch(error => {
                console.error(
                    `❌ ${runtime.config.label}: Yeniden bağlanma hatası.`
                );

                console.error(error);
            });
        },
        delay
    );
}

function bindConnectionEvents(
    runtime,
    connection
) {
    if (
        runtime.boundConnections.has(
            connection
        )
    ) {
        return;
    }

    runtime.boundConnections.add(
        connection
    );

    connection.on(
        VoiceConnectionStatus.Ready,
        () => {
            console.log(
                `✅ ${runtime.config.label}: Ses bağlantısı hazır.`
            );
        }
    );

    connection.on(
        VoiceConnectionStatus.Disconnected,
        async () => {
            if (runtime.shuttingDown) {
                return;
            }

            try {
                /*
                 * Discord bağlantıyı kendi kendine
                 * yeniden kuruyorsa müdahale etmiyoruz.
                 */
                await Promise.race([
                    entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        5000
                    ),

                    entersState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        5000
                    ),
                ]);
            } catch (error) {
                console.log(
                    `⚠️ ${runtime.config.label}: Ses bağlantısı koptu, yeniden bağlanılacak.`
                );

                try {
                    if (
                        connection.state.status !==
                        VoiceConnectionStatus.Destroyed
                    ) {
                        connection.destroy();
                    }
                } catch (destroyError) {
                    console.log(
                        `${runtime.config.label}: Eski bağlantı zaten kapalı.`
                    );
                }

                scheduleReconnect(
                    runtime,
                    5000
                );
            }
        }
    );
}

async function connectToConfiguredChannel(
    runtime
) {
    if (
        runtime.connecting ||
        runtime.shuttingDown
    ) {
        return;
    }

    runtime.connecting = true;

    try {
        const channel =
            await runtime.client.channels.fetch(
                runtime.config.channelId
            );

        if (
            !channel ||
            !channel.isVoiceBased()
        ) {
            throw new Error(
                "Ayarlanan kanal bir ses kanalı değil veya bot kanalı göremiyor."
            );
        }

        runtime.channel = channel;

        /*
         * group değeri çok önemli:
         * Üç bot aynı sunucuda ve aynı Node işleminde
         * çalıştığı için her biri farklı bağlantı grubunda.
         */
        const connection =
            joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator:
                    channel.guild
                        .voiceAdapterCreator,

                selfDeaf: true,
                selfMute: false,

                group:
                    runtime.config.key,
            });

        runtime.connection =
            connection;

        bindConnectionEvents(
            runtime,
            connection
        );

        const subscription =
            connection.subscribe(
                runtime.player
            );

        if (!subscription) {
            throw new Error(
                "Ses oynatıcı bağlantıya bağlanamadı."
            );
        }

        await entersState(
            connection,
            VoiceConnectionStatus.Ready,
            30000
        );

        console.log(
            `🔊 ${runtime.config.label} → ${channel.name} kanalına bağlandı.`
        );

        /*
         * Bot açılırken odada insanlar zaten varsa
         * karşılama müziğini bir kez başlatır.
         */
        if (
            getHumanCount(channel) > 0
        ) {
            playWelcomeMusic(
                runtime
            );
        }
    } catch (error) {
        console.error(
            `❌ ${runtime.config.label}: Ses kanalına bağlanamadı.`
        );

        console.error(
            error.message || error
        );

        scheduleReconnect(
            runtime,
            5000
        );
    } finally {
        runtime.connecting = false;
    }
}

function createWelcomeBot(config) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
        ],
    });

    const player =
        createAudioPlayer({
            behaviors: {
                noSubscriber:
                    NoSubscriberBehavior.Pause,
            },
        });

    const runtime = {
        config,
        client,
        player,

        channel: null,
        connection: null,

        connecting: false,
        shuttingDown: false,
        reconnectTimer: null,

        boundConnections:
            new WeakSet(),
    };

    runtimes.push(runtime);

    player.on(
        AudioPlayerStatus.Playing,
        () => {
            console.log(
                `▶️ ${config.label}: Ses oynatılıyor.`
            );
        }
    );

    player.on(
        AudioPlayerStatus.Idle,
        () => {
            console.log(
                `🔈 ${config.label}: Müzik tamamlandı veya durduruldu.`
            );
        }
    );

    player.on(
        "error",
        error => {
            console.error(
                `❌ ${config.label}: Ses oynatma hatası.`
            );

            console.error(error);
        }
    );

    client.once(
        Events.ClientReady,
        async readyClient => {
            console.log(
                `🤖 ${config.label} çevrimiçi: ${readyClient.user.tag}`
            );

            await connectToConfiguredChannel(
                runtime
            );
        }
    );

    client.on(
        Events.VoiceStateUpdate,
        (oldState, newState) => {
            const changedMember =
                newState.member ||
                oldState.member;

            if (!changedMember) {
                return;
            }

            const targetChannelId =
                config.channelId;

            /*
             * Birisi botu odadan çıkarır veya başka
             * odaya taşırsa kendi odasına geri döner.
             */
            if (
                client.user &&
                changedMember.id ===
                    client.user.id
            ) {
                if (
                    newState.channelId !==
                    targetChannelId
                ) {
                    console.log(
                        `⚠️ ${config.label}: Ayarlanan ses kanalından ayrıldı. Geri dönüyor.`
                    );

                    scheduleReconnect(
                        runtime,
                        2000
                    );
                }

                return;
            }

            if (changedMember.user.bot) {
                return;
            }

            const joinedTargetChannel =
                oldState.channelId !==
                    targetChannelId &&
                newState.channelId ===
                    targetChannelId;

            const leftTargetChannel =
                oldState.channelId ===
                    targetChannelId &&
                newState.channelId !==
                    targetChannelId;

            /*
             * Gerçek bir kullanıcı kayıt odasına
             * girdiğinde müzik baştan başlar.
             */
            if (joinedTargetChannel) {
                console.log(
                    `👤 ${config.label}: ${changedMember.user.tag} kayıt odasına girdi.`
                );

                playWelcomeMusic(
                    runtime
                );

                return;
            }

            /*
             * Kullanıcı ayrıldıktan sonra odada başka
             * gerçek kullanıcı kalmadıysa müzik durur.
             */
            if (leftTargetChannel) {
                setTimeout(
                    async () => {
                        const channel =
                            runtime.client
                                .channels.cache.get(
                                    targetChannelId
                                ) ||
                            await runtime.client
                                .channels.fetch(
                                    targetChannelId
                                )
                                .catch(
                                    () => null
                                );

                        if (
                            getHumanCount(
                                channel
                            ) === 0
                        ) {
                            stopWelcomeMusic(
                                runtime
                            );
                        }
                    },
                    500
                );
            }
        }
    );

    client.login(
        config.token
    ).catch(error => {
        console.error(
            `❌ ${config.label}: Bot hesabına giriş yapılamadı.`
        );

        console.error(
            "Tokeni ve .env dosyasını kontrol et."
        );

        console.error(
            error.message || error
        );
    });
}

function shutdown() {
    console.log(
        "\n🛑 Welcome botları kapatılıyor..."
    );

    for (const runtime of runtimes) {
        runtime.shuttingDown = true;

        if (runtime.reconnectTimer) {
            clearTimeout(
                runtime.reconnectTimer
            );
        }

        try {
            runtime.player.stop(
                true
            );
        } catch (error) {
            // Oynatıcı zaten durmuş olabilir.
        }

        try {
            if (
                runtime.connection &&
                runtime.connection.state
                    .status !==
                    VoiceConnectionStatus.Destroyed
            ) {
                runtime.connection.destroy();
            }
        } catch (error) {
            // Bağlantı zaten kapanmış olabilir.
        }

        try {
            runtime.client.destroy();
        } catch (error) {
            // Client zaten kapanmış olabilir.
        }
    }

    setTimeout(
        () => process.exit(0),
        500
    );
}

validateSettings();

console.log(
    "☕ Çay Ocağı Welcome Botları başlatılıyor..."
);

console.log(
    `🎵 Müzik dosyası: ${AUDIO_FILE}`
);

for (const config of BOT_CONFIGS) {
    createWelcomeBot(config);
}

process.once(
    "SIGINT",
    shutdown
);

process.once(
    "SIGTERM",
    shutdown
);