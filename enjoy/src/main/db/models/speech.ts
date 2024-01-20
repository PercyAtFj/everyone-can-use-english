import {
  AfterCreate,
  AfterDestroy,
  AfterFind,
  BelongsTo,
  HasOne,
  Scopes,
  Table,
  Column,
  Default,
  IsUUID,
  Model,
  DataType,
  AllowNull,
  Unique,
} from "sequelize-typescript";
import mainWindow from "@main/window";
import fs from "fs-extra";
import path from "path";
import settings from "@main/settings";
import OpenAI from "openai";
import { t } from "i18next";
import { hashFile } from "@/utils";
import { Audio, Message } from "@main/db/models";
import log from "electron-log/main";
const { spawn } = require('child_process');
const logger = log.scope("db/models/speech");

async function _generateTTS( text: string, voice: string,file:string ): Promise<null>{
      logger.info('voice: ' + voice);
    return new Promise((resolve, reject) => {
      const ttsProc = spawn('edge-tts', ['--voice', voice, '-t', text, '--write-media', file,'--write-subtitles','/dev/null']);
      ttsProc.stderr.on('data', (data) => {
        logger.error('stderr: ' + data);
      });
      ttsProc.on('exit', (code, signal) => {
        if (!signal && !code) {
          resolve(null);
        }
        if (signal) {
          logger.error('signal: ' + signal);
          throw new Error('edge-tts was killed with signal ' + signal);
        } else if (code) {
          logger.error('code: ' + code);
          throw new Error('edge-tts was killed with code ' + code);
        }
      });
    });
}

@Table({
  modelName: "Speech",
  tableName: "speeches",
  underscored: true,
  timestamps: true,
})
@Scopes(() => ({
  asc: {
    order: [["createdAt", "ASC"]],
  },
  desc: {
    order: [["createdAt", "DESC"]],
  },
}))

export class Speech extends Model<Speech> {
  @IsUUID(4)
  @Default(DataType.UUIDV4)
  @Column({ primaryKey: true, type: DataType.UUID })
  id: string;

  @AllowNull(false)
  @Column(DataType.UUID)
  sourceId: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  sourceType: string;

  @Column(DataType.VIRTUAL)
  source: Message;

  @BelongsTo(() => Message, { foreignKey: "sourceId", constraints: false })
  message: Message;

  @HasOne(() => Audio, "md5")
  audio: Audio;

  @AllowNull(false)
  @Column(DataType.TEXT)
  text: string;

  @AllowNull(false)
  @Column(DataType.JSON)
  configuration: any;

  @Unique
  @Column(DataType.STRING)
  md5: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  extname: string;

  @Column(DataType.VIRTUAL)
  get engine(): string {
    return this.getDataValue("configuration").engine;
  }

  @Column(DataType.VIRTUAL)
  get model(): string {
    return this.getDataValue("configuration").model;
  }

  @Column(DataType.VIRTUAL)
  get voice(): string {
    return this.getDataValue("configuration").model;
  }

  @Column(DataType.VIRTUAL)
  get src(): string {
    return `enjoy://${path.join(
      "library",
      "speeches",
      this.getDataValue("md5") + this.getDataValue("extname")
    )}`;
  }

  @Column(DataType.VIRTUAL)
  get filePath(): string {
    return path.join(
      settings.userDataPath(),
      "speeches",
      this.getDataValue("md5") + this.getDataValue("extname")
    );
  }

  @AfterFind
  static async findSource(findResult: Speech | Speech[]) {
    if (!Array.isArray(findResult)) findResult = [findResult];

    for (const instance of findResult) {
      if (instance.sourceType === "Message" && instance.message !== undefined) {
        instance.source = instance.message;
      }
      // To prevent mistakes:
      delete instance.dataValues.message;
    }
  }

  @AfterCreate
  static notifyForCreate(speech: Speech) {
    this.notify(speech, "create");
  }

  @AfterDestroy
  static notifyForDestroy(speech: Speech) {
    this.notify(speech, "destroy");
  }

  @AfterDestroy
  static cleanupFile(speech: Speech) {
    fs.remove(speech.filePath);
  }

  static notify(speech: Speech, action: "create" | "update" | "destroy") {
    if (!mainWindow.win) return;

    mainWindow.win.webContents.send("db-on-transaction", {
      model: "Speech",
      id: speech.id,
      action: action,
      record: speech.toJSON(),
    });
  }
  static async generate(params: {
    sourceId: string;
    sourceType: string;
    text: string;
    configuration?: any;
  }): Promise<Speech> {
    const { sourceId, sourceType, text, configuration } = params;
    const {
      engine = "openai",
      model = "tts-1",
      voice = "alloy",
      baseUrl,
    } = configuration || {};

    logger.debug("Generating speech", { engine, model, voice });

    const extname = ".mp3";
    const filename = `${Date.now()}${extname}`;
    const filePath = path.join(settings.userDataPath(), "speeches", filename);


    if (engine === "openai") {
      const key = settings.getSync("openai.key") as string;
      if (!key) {
        throw new Error(t("openaiKeyRequired"));
      }
      const openai = new OpenAI({
        apiKey: key,
        baseURL: baseUrl,
      });
      logger.debug("baseURL", openai.baseURL);

      const file = await openai.audio.speech.create({
        input: text,
        model,
        voice,
      });

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.outputFile(filePath, buffer);
    } else if (engine === "edge-tts") {
      const _voice = model + "-" + voice + "Neural";
      await _generateTTS(text,_voice, filePath);
    }

    const md5 = await hashFile(filePath, { algo: "md5" });
    fs.renameSync(
      filePath,
      path.join(path.dirname(filePath), `${md5}${extname}`)
    );

    return Speech.create({
      sourceId,
      sourceType,
      text,
      extname,
      md5,
      configuration: {
        engine,
        model,
        voice,
      },
    });
  }
}
