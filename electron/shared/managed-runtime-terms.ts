export type RuntimeTermsDocument={id:string;title:string;version?:string;files:string[];originalSha256:string;koreanAvailable?:boolean}
export type ManagedRuntimeTermsState={fingerprint:string;accepted:boolean;error:string|null;documents:RuntimeTermsDocument[];cudaNotice?:{id:string;title:string}}
export type RuntimeTermsView='original'|'text'|'korean-original'|'korean-text'
