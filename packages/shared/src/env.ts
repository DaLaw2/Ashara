/** Optional operator override for the models.toml config path (`ASHARA_MODELS_CONFIG`). */
export function loadModelsConfigPathEnvOverride(): string | undefined {
    return nonEmpty(process.env["ASHARA_MODELS_CONFIG"]);
}

function nonEmpty(value: string | undefined): string | undefined {
    if (!value || value.trim() === "") return undefined;
    return value;
}
