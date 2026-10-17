export interface InspectorFieldReference {
  __inspectorField: true;
  eventKey: string;
  field: string;
  path: Array<string | number>;
  originalChars: number;
  preview: string;
  loadable: boolean;
}

export interface InspectorFieldSelection {
  field: string;
  path?: Array<string | number>;
  offset?: number;
  limit?: number;
}

export interface InspectorFieldPage {
  eventKey: string;
  field: string;
  path: Array<string | number>;
  format: "text" | "json";
  content: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  complete: boolean;
}
