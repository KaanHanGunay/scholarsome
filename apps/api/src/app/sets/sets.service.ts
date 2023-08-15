import { Injectable } from "@nestjs/common";
import { PrismaService } from "../providers/database/prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { AnkiCard, AnkiNote, Set } from "@scholarsome/shared";
import { Request as ExpressRequest } from "express";
import jwt_decode from "jwt-decode";
import { UsersService } from "../users/users.service";
import * as AdmZip from "adm-zip";
import * as Database from "better-sqlite3";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import * as sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { S3 } from "@aws-sdk/client-s3";

@Injectable()
export class SetsService {
  /**
   * @ignore
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService
  ) {}

  /**
   * Removes set media files from S3 or local storage
   *
   * @param setId ID of the set to delete media from
   */
  async deleteSetMediaFiles(setId: string): Promise<void> {
    if (
      this.configService.get<string>("STORAGE_TYPE") === "s3" ||
      this.configService.get<string>("STORAGE_TYPE") === "S3"
    ) {
      const s3 = await new S3({
        credentials: {
          accessKeyId: this.configService.get<string>("S3_STORAGE_ACCESS_KEY"),
          secretAccessKey: this.configService.get<string>("S3_STORAGE_SECRET_KEY")
        },
        endpoint: this.configService.get<string>("S3_STORAGE_ENDPOINT"),
        region: this.configService.get<string>("S3_STORAGE_REGION")
      });

      const listedObjects = await s3.listObjectsV2( { Bucket: this.configService.get<string>("S3_STORAGE_BUCKET"), Prefix: "media/sets/" + setId } );
      if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

      const objects: { Key: string }[] = [];

      for (const object of listedObjects.Contents) {
        objects.push({ Key: object.Key });
      }

      await s3.deleteObjects({ Bucket: this.configService.get<string>("S3_STORAGE_BUCKET"), Delete: { Objects: objects } });
      await s3.deleteObject({ Bucket: this.configService.get<string>("S3_STORAGE_BUCKET"), Key: "media/sets/" + setId });
    }

    if (this.configService.get<string>("STORAGE_TYPE") === "local") {
      const filePath = path.join(this.configService.get<string>("STORAGE_LOCAL_DIR"), "media", "sets", setId);

      if (!fs.existsSync(filePath)) return;
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  }

  /**
   * Verifies whether a set belongs to a user given their access token cookie
   *
   * @param req Request object of the user
   * @param setId ID of the set to check against
   *
   * @returns Whether the set belongs to the user
   */
  public async verifySetOwnership(req: ExpressRequest, setId: string): Promise<boolean> {
    let accessToken: { id: string; email: string; };

    if (req.cookies && req.cookies["access_token"]) {
      accessToken = jwt_decode(req.cookies["access_token"]) as { id: string; email: string; };
    } else {
      return false;
    }

    const user = await this.usersService.user({
      id: accessToken.id
    });

    const set = await this.set({
      id: setId
    });

    if (!set || !user) return false;

    return set.author.id === user.id;
  }

  /**
   * Converts the Buffer of a .apkg file to a JSON of the cards contained within
   * and uploads media to storage destination (local or S3)
   *
   * Only supports Basic note types in Anki
   *
   * @param file Buffer of the .apkg file
   * @param setId UUID to be used for the set ID
   *
   * @returns Array of cards generated from the file
   */
  public async decodeAnkiApkg(file: Buffer, setId: string): Promise<{ cards: AnkiCard[], media: string[] } | false> {
    const zip = new AdmZip(file);
    const dbFile = zip.readFile("collection.anki2");

    const db = new Database(dbFile);
    let notes: AnkiNote[] = db.prepare("SELECT * FROM Notes").all() as AnkiNote[];

    const cards: {
      term: string;
      definition: string;
      index: number;
    }[] = [];

    const media: string[] = [];

    if (
      notes[0].flds.split(/\x1F/)[0].includes("Please update to the latest Anki version")
    ) {
      notes = new Database(zip.readFile("collection.anki21")).prepare("SELECT * FROM Notes").all() as AnkiNote[];
    }

    for (const [i, note] of notes.entries()) {
      const split = note.flds.split(/\x1F/);

      if (split.length > 2) {
        return false;
      }

      // audio polyfill
      const termAudio = split[0].match(/\[sound:(.*?)\]/);
      if (termAudio) split[0] = split[0].replace(termAudio[0], `<audio controls><source src="${termAudio[1]}"></audio>`);

      const definitionAudio = split[1].match(/\[sound:(.*?)\]/);
      if (definitionAudio) split[1] = split[1].replace(definitionAudio[0], `<audio controls><source src="${definitionAudio[1]}"></audio>`);

      // font -> p tag polyfill
      split[0] = split[0].replaceAll("<font", "<span").replaceAll("</font>", "</span>");
      split[1] = split[1].replaceAll("<font", "<span").replaceAll("</font>", "</span>");

      cards.push({
        term: split[0],
        definition: split[1],
        index: i
      });
    }

    db.close();

    // by this point we already know all cards are compatible
    if (zip.readFile("media")) {
      let mediaLegend: string[][];

      try {
        mediaLegend = Object.entries(JSON.parse(zip.readFile("media").toString()));
      } catch (e) {
        mediaLegend = null;
      }

      if (mediaLegend) {
        for (const [i, card] of cards.entries()) {
          const termMatches = card.term.match(/<[^>]+src="([^">]+)"/g);
          const definitionMatches = card.definition.match(/<[^>]+src="([^">]+)"/g);

          let sources = [];

          if (termMatches) sources = Object.values(termMatches);
          if (definitionMatches) sources = [...sources, ...Object.values(definitionMatches)];

          // if there are any sources
          if (sources) {
            // extract src attribute from img tag
            sources = sources.map((x) => x.replace(/.*src="([^"]*)".*/, "$1"));

            for (const source of sources) {
              // find index in mediaLegend
              for (let x = 0; x < mediaLegend.length; x++) {
                if (mediaLegend[x][1] === source) {
                  // convert to jpeg and compress
                  let file = zip.readFile(mediaLegend[x][0]);
                  let extension = mediaLegend[x][1].split(".").pop();

                  if (
                    extension === "jpeg" ||
                    extension === "jpg" ||
                    extension === "png" ||
                    extension === "tiff" ||
                    extension === "webp"
                  ) {
                    file = await sharp(zip.readFile(mediaLegend[x][0])).jpeg({ progressive: true, force: true, quality: 80 }).toBuffer();
                    extension = ".jpeg";
                  } else {
                    extension = mediaLegend[x][1].split(".").pop();
                  }

                  // in the format of setId/fileName.jpeg
                  const name = crypto.randomUUID();
                  media.push(name + extension);

                  const fileName = setId + "/" + name + extension;

                  // upload to s3
                  if (
                    this.configService.get<string>("STORAGE_TYPE") === "s3" ||
                    this.configService.get<string>("STORAGE_TYPE") === "S3"
                  ) {
                    const s3 = await new S3({
                      credentials: {
                        accessKeyId: this.configService.get<string>("S3_STORAGE_ACCESS_KEY"),
                        secretAccessKey: this.configService.get<string>("S3_STORAGE_SECRET_KEY")
                      },
                      endpoint: this.configService.get<string>("S3_STORAGE_ENDPOINT"),
                      region: this.configService.get<string>("S3_STORAGE_REGION")
                    });

                    await s3.putObject({ Body: file, Bucket: this.configService.get<string>("S3_STORAGE_BUCKET"), Key: "media/sets/" + fileName });
                  }

                  // upload locally
                  if (this.configService.get<string>("STORAGE_TYPE") === "local") {
                    const filePath = path.join(this.configService.get<string>("STORAGE_LOCAL_DIR"), "media", "sets");

                    if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });
                    if (!fs.existsSync(path.join(filePath, setId))) fs.mkdirSync(path.join(filePath, setId), { recursive: true });

                    fs.writeFileSync(path.join(filePath, fileName), file);
                  }

                  // replace src with new fileName
                  cards[i].term = cards[i].term.replace(mediaLegend[x][1], "/api/media/sets/" + fileName);
                  cards[i].definition = cards[i].definition.replace(mediaLegend[x][1], "/api/media/sets/" + fileName);

                  break;
                }
              }
            }
          }
        }
      }
    }

    return { cards, media };
  }

  /**
   * Queries the database for a unique set
   *
   * @param setWhereUniqueInput Prisma `SetWhereUniqueInput` selector
   *
   * @returns Queried `Set` object
   */
  async set(
      setWhereUniqueInput: Prisma.SetWhereUniqueInput
  ): Promise<Set | null> {
    return this.prisma.set.findUnique({
      where: setWhereUniqueInput,
      include: {
        cards: true,
        author: {
          select: {
            id: true,
            username: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });
  }

  /**
   * Queries the database for multiple sets
   *
   * @param params.skip Optional, Prisma skip selector
   * @param params.take Optional, Prisma take selector
   * @param params.cursor Optional, Prisma cursor selector
   * @param params.where Optional, Prisma where selector
   * @param params.orderBy Optional, Prisma orderBy selector
   *
   * @returns Array of queried `Set` objects
   */
  async sets(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.SetWhereUniqueInput;
    where?: Prisma.SetWhereInput;
    orderBy?: Prisma.SetOrderByWithRelationInput;
  }): Promise<Set[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.set.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      include: {
        cards: true,
        author: {
          select: {
            id: true,
            username: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });
  }

  /**
   * Creates a set in the database
   *
   * @param data Prisma `SetCreateInput` selector
   *
   * @returns Created `Set` object
   */
  async createSet(data: Prisma.SetCreateInput): Promise<Set> {
    return this.prisma.set.create({
      data,
      include: {
        cards: true,
        author: {
          select: {
            id: true,
            username: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });
  }

  /**
   * Updates a set in the database
   *
   * @param params.where Prisma where selector
   * @param params.data Prisma data selector
   *
   * @returns Updated `Set` object
   */
  async updateSet(params: {
    where: Prisma.SetWhereUniqueInput;
    data: Prisma.SetUpdateInput;
  }): Promise<Set> {
    const { where, data } = params;
    return this.prisma.set.update({
      data,
      where,
      include: {
        cards: true,
        author: {
          select: {
            id: true,
            username: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });
  }

  /**
   * Deletes a set from the database
   *
   * @param where Prisma `SetWhereUniqueInput` selector
   *
   * @returns `Set` object that was deleted
   */
  async deleteSet(where: Prisma.SetWhereUniqueInput): Promise<Set> {
    return this.prisma.set.delete({
      where,
      include: {
        cards: true,
        author: true
      }
    });
  }
}
