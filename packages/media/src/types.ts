export type BlobDescriptor = {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
  readonly uploaded: number;
  readonly dim?: string;
  readonly blurhash?: string;
  readonly thumb?: string;
  readonly duration?: number;
};

export type BlobMeta = {
  readonly dim: string;
  readonly blurhash: string;
  readonly thumbUrl: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: number;
  readonly durationSecs?: number;
};

export type UploadNetworkInfo = {
  readonly ip?: string;
  readonly port?: number;
};

export type UploadAttribution = {
  readonly uploaderName?: string;
  readonly network: UploadNetworkInfo;
};

export type UploadRecord = {
  readonly version: 1;
  readonly eventId: string;
  readonly sha256: string;
  readonly ext: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: number;
  readonly communityId: string;
  readonly communityHost: string;
  readonly uploaderId: string;
  readonly uploaderNpub: string;
  readonly uploaderName?: string;
  readonly ip?: string;
  readonly port?: number;
};
