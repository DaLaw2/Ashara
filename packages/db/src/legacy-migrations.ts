/**
 * The numbered files 000_init.sql stands in for, each with the sha256 of its bytes. A database whose
 * schema_migrations lists every one of them with this hash holds the schema the init creates, so the
 * runner records the init as applied instead of running it. Only names and hashes are kept: they are
 * all the check reads.
 */
export const LEGACY_MIGRATIONS: readonly { readonly filename: string; readonly sha256: string }[] = [
  { filename: "001_initial.sql", sha256: "6b841dfaf6ccdcd64c7500c909046c95f5c12bbed687d90cdb9c131412be8380" },
  { filename: "002_seed_models.sql", sha256: "4e508f61765dbbfc86c0333c3aea4eec1710ae713f3812c157f79d4a46ec750a" },
  { filename: "003_add_run_scope.sql", sha256: "ff2f2a3176bb75ac8d76b040f89750727461ee14c8978b39f28435b2729ae1bc" },
  { filename: "004_drop_unused_storage.sql", sha256: "422ce2d5af45987278b0cb20a26e729940961f92553822f87173364395d79327" },
  { filename: "005_retire_split_and_bug_fix.sql", sha256: "28629f2bcb7553e75abe309fd681cca4b8bf31bc1e509111ec3fc16e574d4484" },
  { filename: "006_drop_unread_columns.sql", sha256: "d3bdfa26f89ec1e10cb12fcd3f1c5cdc9a4b114998300065863abadb82a16ede" },
  { filename: "007_drop_format_group.sql", sha256: "0aebe5eeeef0debd81d9c0a510d14af2d44c6978339639b0e52585a2c997de42" },
  { filename: "008_drop_brainstorm_log.sql", sha256: "39bdf2e787c48d15a46b1165359a7da135961444d36bc30f61d707be03c932f5" },
  { filename: "009_narrow_work_item_level.sql", sha256: "ff950c4fe78939860047c747d1d7b7b35a9520b2565e0360b868d203b5f27a7d" },
  { filename: "010_retire_run_end_sources.sql", sha256: "8048d83c9031f5d4054ad124aef38adeac2875abc67c1d308c374f8d45259372" },
  { filename: "011_contract_knowledge_only.sql", sha256: "7e64aed55c8662bb0c5916897cdfccf69ffa3f7ba759de182bb06bc66c27d819" },
  { filename: "012_secret_store.sql", sha256: "1c4db45da55fe29b54baf699f957f5abd6d5131bbf0a5efda65bc9b7b68f0469" },
  { filename: "013_drop_plaintext_credentials.sql", sha256: "2de16f21e6784103254e143859455ca6dc2e7fcbaa74c3504ad5669e228f6056" },
  { filename: "014_projects.sql", sha256: "0985f4836614163725f5524996ca4f78f9dc133019ceb8e8e621e7d4a428572d" },
  { filename: "015_llm_calls.sql", sha256: "6194cea6a15dd4446bcffb876eb3cf8d954c906ec5554fe580a7adde87fb4182" },
  { filename: "016_client_messages.sql", sha256: "d09aa4ee3b028efab49ceaa3b27d1d654539603afb9ff2e1a7a4116ff5c5edff" },
  { filename: "017_client_sessions.sql", sha256: "5d761eb4ba964fe9364f34da7d2f1e21868c8f5695bfa71866204609d353157f" },
  { filename: "018_clients.sql", sha256: "b5afdc7c4c0682695d646dd1eda097aed9d810e370807a64f9711b725e075de6" },
  { filename: "019_intake_attempts.sql", sha256: "4f8163dab7850aa4400f6d0af69064ebdce2c2871a282740aa660ce94d7d1319" },
  { filename: "020_first_plan.sql", sha256: "622c7b79b9c37767e2bb5c9f2a44bc6cc016ebd3f3c7fc8435722737db7184da" },
  { filename: "021_model_catalog_refresh.sql", sha256: "422c7e9f7b19364fb84b785cf2954ab1ae34b539276549aa8aac1d9a0bc19843" },
  { filename: "022_question_position.sql", sha256: "09f2d2b9287732713049d4e1c5e303e1fd6ad0317e0436908607bf1917cb9ade" },
  { filename: "023_drop_legacy_sonnet_5.sql", sha256: "3ddba10be012e1eaea7be16c3ae682642ca8b9c44da0d37f202891e2d2cb8903" },
  { filename: "024_project_workspace_path.sql", sha256: "27f21280d68dd42ec642a8d42f42e723cb5c3967680866c4ae4e82c7eee13dfc" },
  { filename: "025_project_blocked_reason.sql", sha256: "cdcab93e0dfe1143aea08713eac26ac650afe4a4f9f348dae400ad3abd4c77e7" },
  { filename: "026_catalog_verified_models.sql", sha256: "da52865c76835b51836f7f1709e6fb26c5023604a7bef03283a375fdf3da244d" },
  { filename: "027_login_attempts_by_source.sql", sha256: "e48686d9b1f85973e2af3ed1bdf5bf0b1adbdb0c90330dc91d252d42f30704fe" },
  { filename: "028_project_client_stop.sql", sha256: "958d70d2a3b68487d164ae04ff505bfc639da939f7850d7e6fa5b446644b684f" },
  { filename: "029_provider_type_selects_adapter.sql", sha256: "23cdc8b4958b374416f90b843d910d5ad5353eeb63cacce57ae0fcb00249c6d4" },
  { filename: "030_llm_call_finish_reason.sql", sha256: "f9da3356ed03ca5723c075eec8e112fcd8bd1e43502a09dd0bb36295051c7674" },
  { filename: "031_roster_roles.sql", sha256: "5a6c22583abf21c8dd621811c84a88aed26f6f0a88e4cb0cd1a5600f115596aa" },
  { filename: "032_environment_builds.sql", sha256: "25f93415da7269c3f7b965242cdc553110ef92563981f91f207980167df7988d" },
  { filename: "033_sprint0_and_dropped_plan_dependencies.sql", sha256: "d71be5dfaa7994116212aff16e410ed83af1ef42e49e81fed061a82d72c008a1" },
  { filename: "034_dispatch_by_environment_version.sql", sha256: "32196785954204ba76f594ba447e72a9795325bc569e66c5d686ccbe5a61df7e" },
  { filename: "035_spend_cap_from_llm_calls.sql", sha256: "8a427e5c9eaf5ff201a44be349f5a8e24970784534df01a63b4e8db770d23f1d" },
  { filename: "036_task_checks.sql", sha256: "22e9170f49559693d508f1f7b27e4d2e53c97a9c6c998c9969c0c03e26f21b56" },
  { filename: "037_environment_statement_version.sql", sha256: "24bd06263bb89f8ac5fb47852dbc182db8a98f5b05e46a412b1c5ec248c7bfd6" },
  { filename: "038_client_answers.sql", sha256: "08639bd46166f95c0bcf20b10edba0877ad44baee2d41afffd21c9cd417c878a" },
  { filename: "039_check_disputes.sql", sha256: "6d56fed1919ccb3cdaaac69cea93c259be90886085ad935c1723a12bfcd26522" },
  { filename: "040_block_episodes.sql", sha256: "d52dd5cc09f14839661c585c5adafa970878787541cad46c3f5f3102132740cc" },
  { filename: "041_work_item_merge_commit.sql", sha256: "46a34b43476977327edc1337420d301b01000dc674a52d69a9eebad38c5f82a9" },
  { filename: "042_plan_revisions.sql", sha256: "de178d5de3da7a4e7c44c1c70c4cbb09783a2ae3d0f9c951725aedda43bd645c" },
  { filename: "043_environment_statement_on_implementation.sql", sha256: "1c2eb3bbbbf02bace21c24e7fb69aec4f1d6f1e39ce66b2087e01db750377b3a" },
  { filename: "044_suite_review_findings.sql", sha256: "b4d4a2573cff8dfe449926e8de04e8dc68953eba50d91bcb8b216573b710212d" },
  { filename: "045_delivery_lifecycle.sql", sha256: "58745c40acb6ac0c878f7b7b81645233237bee3d2b147fa4671d4d2cd243a4c3" },
  { filename: "046_dev_session_attempt_evidence.sql", sha256: "1efb9ee502c8740237922b9fef5b656da1dfea1e29fdec55e00ff17ad54e121a" },
  { filename: "047_model_catalog_current.sql", sha256: "07ebafc6f4e970fca65731a4df7fd3a0381f6629925010f9a99e78e65c2a7de0" },
  { filename: "048_no_item_waits.sql", sha256: "5d412d7dbfffa66c1db5868781ac24d177e0d2425b554559782eeceadafd4ece" },
  { filename: "049_project_accepted.sql", sha256: "d9e22e3cf0dfc0db06054c2e6fa80bbf20a73fce1b07df24aaa655830fa80498" },
  { filename: "050_attempt_output_truncated.sql", sha256: "a9a8d6ecc4b1a9fdfabf24f0023f9be836d10e7b4c2fb052869cfc17e9264956" },
  { filename: "051_project_scoped_knowledge.sql", sha256: "df8979e3eaab54bee93f5f31280694424b500b4ffb0ee59069db5da1656a7400" },
  { filename: "052_replan_requests.sql", sha256: "f4cfed98b5c6c34b7a08ea6e85a25b32ed37f2d57933f99fde15bb7d9264d9ff" },
  { filename: "053_llm_call_admission_rows.sql", sha256: "279a0e490c7a673b3e6f267271765afaa8d8b8a041d5301acef6c57d6ddd1f64" },
  { filename: "054_model_config_no_evidence_defaults.sql", sha256: "bdf1f748d8c240879c779f1ec4805ae504f2d1d80d0cfd6a9d3895010cee885d" },
  { filename: "055_drop_project_contracts.sql", sha256: "3678cb055c0b49d9cb275f4afa11c7627ccc2a35aa182132757bf3019ea61368" },
  { filename: "056_drop_run_scope.sql", sha256: "f610e603a0e33026d0f8ba2280b510df6edb95a5ef01eef25a899ff113fbe3d5" },
  { filename: "057_failure_given_up.sql", sha256: "81e0d37bf6ad6f1be2469fc79c017c2d67e1d14a5425e443f77d8ab1071ecdbe" },
  { filename: "058_failure_verdict.sql", sha256: "c2c1574effaba4ac79b1cccfedfc16a7012e88e1b8c11ed28159df1e332cea82" },
  { filename: "059_project_lifecycle_halt_split.sql", sha256: "59d2dc49ab4e9f196df6c927204c25161be802ed4c92cbce0677534dd417069c" },
  { filename: "060_recorded_facts_only.sql", sha256: "67106a379467b79ef6760fbd940d1088a36756a66e78a2571597574f62b07f22" },
  { filename: "061_drop_dead_columns.sql", sha256: "cb202308593d5231bb0f13631ff3f06146baad1227281e4404ef9aaea69f4681" },
  { filename: "062_contained_report_and_provider_halt.sql", sha256: "c37a2f32ade9442df97cd6240e0abca3158b9f1561fdbfe2461dc423f5f2a021" },
  { filename: "063_review_judgements_and_contained_steps.sql", sha256: "ebe65a665ee26d72b088fb2ec0f32a2ded8c01af3011c97bf8ea3c6c22008cca" },
  { filename: "064_task_check_decides.sql", sha256: "da1084d817e228ae71af2a2eef6131ca8ec2d450ed88754579400058e04b7671" },
  { filename: "065_acceptance_executed_checks.sql", sha256: "092e6916cb0a70656ed4b04b3c0c778b361af5e02995dc9a26a4f0812be9bdb5" },
  { filename: "066_counted_attempt_failure.sql", sha256: "464a90a599b33ada186d0971cd3e1581d8b2a59a01ee14224d7b9287311a9d06" },
  { filename: "067_work_ledger.sql", sha256: "063b24633ccf3ed831af53f9bd1e42fbc5b8d55d0853d8e6b101f43bc4385244" },
  { filename: "068_work_reserve_and_burn_warnings.sql", sha256: "ac7094f25d247bee8d7fa706a6a9c1bde51cb4b139f80f5e13c8b9a621b053c5" },
  { filename: "069_witnessed_review_and_check_set_freeze.sql", sha256: "9ec9c68b5c141a491bb2d99049033181d847097d3512e2e3295e15803e025afc" },
  { filename: "070_crash_orphans.sql", sha256: "5337d7ed8cc0406fc18b2d8af5d78d7103a4dcb3a7e12334350b39504e944449" },
  { filename: "071_failed_second_review.sql", sha256: "7941e587e033d4b5f71e6f7c4184f151d607e45aebeafed267000fa036fac8fe" },
  { filename: "072_clean_review_claims.sql", sha256: "29122d10993dce0abf29ad13c88fa2d2197e975e77b270b5e4c890bfc0881419" },
  { filename: "073_second_opinion_strength.sql", sha256: "6b65e42c6a5411cc3a7a76c7a155ee69af7facd3e2666a165429a0eaa7b65a86" },
  { filename: "074_intake_readings.sql", sha256: "b26e427a36bf2b97458eec7dffc982b0df231aa6a47ce39fc45f136cf76b5a5d" },
  { filename: "075_context_window_guard.sql", sha256: "bebade7c20fca48ed035f0016d84cc913367c9665b67c649e717a6da40917533" },
  { filename: "076_overflowed_window.sql", sha256: "0875dc58b9bf7b8d010bb1eec097f306848079ac8fb8d15cbf8a575edef395cc" },
  { filename: "077_repairs_task_link.sql", sha256: "08e2076523f997a711156d2a4965f942826f3fd3164006135c889595d770f89e" },
  { filename: "078_trace_ids.sql", sha256: "48adeb1094098f556204323dc1daefde29a130a39fa9694df1d8686ffc42fbac" },
  { filename: "079_undecided_item_claims.sql", sha256: "5af65e07a040ce00c0f6d8ef3ccdccb2779bae150273a3724f72f23f78407172" },
];

/**
 * No file in LEGACY_MIGRATIONS carries the name a caller asked for.
 * @testseam legacy-migrations.test.ts checks an unlisted name is refused
 */
export class LegacyMigrationUnlisted extends Error {
  constructor(readonly change: string) {
    super(`no numbered file the init stands in for is named ${change}.sql past its number`);
    this.name = "LegacyMigrationUnlisted";
  }
}

/**
 * The listed numbered file whose name past its number is `change`: a caller names the schema change
 * it depends on, and the number stays with the list it belongs to.
 */
export function legacyMigrationFile(change: string): string {
  const listed = LEGACY_MIGRATIONS.find((m) => m.filename.replace(/^\d{3}_/, "") === `${change}.sql`);
  if (listed === undefined) throw new LegacyMigrationUnlisted(change);
  return listed.filename;
}
