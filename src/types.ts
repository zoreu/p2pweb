export interface PublishedSite {
  url: string;
  createdAt: number;
}

export interface P2PRequest {
  type: 'http-request';
  requestId: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface P2PResponse {
  type: 'http-response';
  requestId: string;
  status: number;
  statusText?: string;
  body: string;
  headers: Record<string, string>;
  isBinary?: boolean;
}
