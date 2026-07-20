declare global {
    namespace Express {
        interface Request {
            id: string;
            validatedQuery?: unknown;
        }
    }
}

export {};
