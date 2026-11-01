export interface Clock { now(): string }
export interface IdGen { next(): string }
export interface Fingerprinter { digest(value: string): string }
