export type RequestFixture = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type ResponseSnapshot = {
  status: number;
  body: string;
  "content-type": string | null;
};

export type FileResult = {
  file: string;
  compiles: boolean;
  matches: boolean;
  sizeBytes: number | null;
  compileMs: number;
  runMs: number | null;
  error: string | null;
};

export type CompatReport = {
  generatedAt: string;
  porfforVersion: string;
  requestsPerFile: number;
  files: FileResult[];
};
