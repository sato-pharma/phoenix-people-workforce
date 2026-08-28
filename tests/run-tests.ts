import { runI18nConfigTests } from "./i18n-config.test.ts";
import { runI18nCairoDateBoundaryTests } from "./i18n-cairo-date-boundary.test.ts";
import { runPortalTargetDedupTests } from "./portal-target-dedup.test.ts";
import { runTargetsViewScopeTests } from "./targets-view-scope.test.ts";
import { runTestWiringCompleteTests } from "./test-wiring-complete.test.ts";
import { runCrmPortalScopeTests } from "./crm-portal-scope.test.ts";
import { runEmployee360VisitClassificationTests } from "./employee-360-visit-classification.test.ts";
import { runEmployee360DoubleVisitCountTests } from "./employee-360-double-visit-count.test.ts";
import { runErrorMonitorNewIssueDiffTests } from "./error-monitor-new-issue-diff.test.ts";
import { runErrorMonitorDerivedStatusTests } from "./error-monitor-derived-status.test.ts";
import { runErrorMonitorMessageDecodeTests } from "./error-monitor-message-decode.test.ts";
import { runErrorMonitorAiRedactTests } from "./error-monitor-ai-redact.test.ts";
import { runErrorMonitorUserAttemptsTests } from "./error-monitor-user-attempts.test.ts";
import { runGcpMetricsTests } from "./gcp-metrics.test.ts";
import { runWeeklySystemHealthDigestTests } from "./weekly-system-health-digest.test.ts";
import { runMailboxComplianceMonitorTests } from "./mailbox-compliance-monitor.test.ts";
import { runNavigationActivePathTests } from "./navigation-active-path.test.ts";
import { runNavigationRuling11AnalyticsTests } from "./navigation-ruling-11-analytics.test.ts";
import { runHrUrlNamespaceTests } from "./hr-url-namespace.test.ts";
import { runNotificationLinksResolveTests } from "./notification-links-resolve.test.ts";
import { runNavigationPersonalLayoutTests } from "./navigation-personal-layout.test.ts";
import { runFinanceManagerSixModuleAccessTests } from "./finance-manager-six-module-access.test.ts";
import { runSidebarLabelFontSyncTests } from "./sidebar-label-font-sync.test.ts";
import { runSidebarLabelWidthTests } from "./sidebar-label-width.test.ts";
import { runAutomatedPayrollPageWidthTests } from "./automated-payroll-page-width.test.ts";
import { runWorkspaceSingleHeroTests } from "./workspace-single-hero.test.ts";
import { runSidebarRoleScopedHeadingsTests } from "./sidebar-role-scoped-headings.test.ts";
import { runSosProductMappingCheckTests } from "./sos-product-mapping-checks.test.ts";
import { runIncentiveSchemeTests } from "./incentive-scheme.test.ts";
import { runEmailNotificationTests } from "./email-notifications.test.ts";
import { runEmailGovernanceTests } from "./email-governance.test.ts";
import { runNotificationConfidenceGateTests } from "./notification-confidence-gate.test.ts";
import { runOpenAiClientTests } from "./openai-client.test.ts";
import { runEmailAiAssistTests } from "./email-ai-assist.test.ts";
import { runSosAiSuggestRetryTests } from "./sos-ai-suggest-retry.test.ts";
import { runTransactionalEmailNotUnsubscribableTests } from "./transactional-email-not-unsubscribable.test.ts";
import { runEmployeeImportAlertRecipientTests } from "./employee-import-alert-recipients.test.ts";
import { runPayrollWorkflowAlertRecipientTests } from "./payroll-workflow-alert-recipients.test.ts";
import { runAttendanceAlertNoEmailTests } from "./attendance-alert-no-email.test.ts";
import { runForceLogoutHrIdCasingTests } from "./force-logout-hr-id-casing.test.ts";
import { runResignationNotificationSubjectTests } from "./resignation-notification-subject.test.ts";
import { runNotificationGovernanceHardeningTests } from "./notification-governance-hardening.test.ts";
import { runBirthdayEligibilityTests } from "./birthday-eligibility.test.ts";
import { runUnifiedNotificationsTests } from "./unified-notifications.test.ts";
import { runNotificationStepRunnerTests } from "./notification-step-runner.test.ts";
import { runPayslipEmailBlockTests } from "./payslip-email-block.test.ts";
import { runActiveRosterOnlyTests } from "./active-roster-only.test.ts";
import { runEarlyBirdsEmailBlockTests } from "./early-birds-email-block.test.ts";
import { runMarketingSlaEmailBlockTests } from "./marketing-sla-email-block.test.ts";
import { runRecruitmentAttachmentFilenameNameTests } from "./recruitment-attachment-filename-name.test.ts";
import { runRecruitmentCvNoEmailTests } from "./recruitment-cv-no-email.test.ts";
import { runCandidateAssignedEmailBlockTests } from "./candidate-assigned-email-block.test.ts";
import { runTelegramOperationsTests } from "./telegram-operations.test.ts";
import { runTelegramAdminControlCenterTests } from "./telegram-admin-control-center.test.ts";
import { runEmailAdminControlCenterTests } from "./email-admin-control-center.test.ts";
import { runTelegramTemplateManagementTests } from "./telegram-template-management.test.ts";
import { runTelegramHardeningTests } from "./telegram-hardening.test.ts";
import { runTelegramDeliveryErrorsTests } from "./telegram-delivery-errors.test.ts";
import { runConfigDriftTests } from "./config-drift.test.ts";
import { runPushEnableHangTests } from "./push-enable-hang.test.ts";
import { runPushRegisterHrIdGuardTests } from "./push-register-hr-id-guard.test.ts";
import { runLiveSheetStaleBannerTests } from "./live-sheet-stale-banner.test.ts";
import { runBrevoKeepaliveTests } from "./brevo-keepalive.test.ts";
import { runResidenceGeocodePolicyTests } from "./residence-geocode-policy.test.ts";
import { runOutstationFuelPolicyTests } from "./outstation-fuel-policy.test.ts";
import { runDeadMansSwitchTests } from "./dead-mans-switch.test.ts";
import { runDirectOrdersSweepLivenessTests } from "./direct-orders-sweep-liveness.test.ts";
import { runHealthchecksScheduleSyncTests } from "./healthchecks-schedule-sync.test.ts";
import { runDirectOrdersHrIdCaseTests } from "./direct-orders-hr-id-case.test.ts";
import { runDbHealthSnapshotLivenessTests } from "./db-health-snapshot-liveness.test.ts";
import { runSheetTokenRotationLivenessTests } from "./sheet-token-rotation-liveness.test.ts";
import { runSyntheticJourneysLivenessTests } from "./synthetic-journeys-liveness.test.ts";
import { runPayrollEngineHardeningTests } from "./payroll-engine-hardening.test.ts";
import { runPayrollSheetMappingTests } from "./payroll-sheet-mapping.test.ts";
import { runPayrollWorkflowTests } from "./payroll-workflow.test.ts";
import { runCspHeaderTests } from "./csp-headers.test.ts";
import { runPdfCanvasTraceTests } from "./pdf-canvas-trace.test.ts";
import { runMoneyPathSilentFailureTests } from "./money-path-silent-failures.test.ts";
import { runReadyPayrollProrationTests } from "./ready-payroll-proration.test.ts";
import { runReadyPayrollTemplateFormulaTests } from "./ready-payroll-template-formulas.test.ts";
import { runPhoenixHrReplyTemplateTests } from "./phoenix-hr-reply-template.test.ts";
import { runPlatformMetricsTests } from "./platform-metrics.test.ts";
import { runCeoAccountContractTests } from "./ceo-account-contract.test.ts";
import { runExpenseMetricsTests } from "./expense-metrics.test.ts";
import { runPayrollMoneyTests } from "./payroll-money.test.ts";
import { runSalesMoneyRoundingTests } from "./sales-money-rounding.test.ts";
import { runExpenseTripDedupTests } from "./expense-trip-dedup.test.ts";
import { runOutstationDecisionTests } from "./outstation-decision.test.ts";
import { runOutstationExpenseImportTripIdTests } from "./outstation-expense-import-tripid.test.ts";
import { runMarketingBulkImportAtomicityTests } from "./marketing-bulk-import-atomicity.test.ts";
import { runSalesBulkImportGatingTests } from "./sales-bulk-import-gating.test.ts";
import { runMarketingAccessGatesTests } from "./marketing-access-gates.test.ts";
import { runValidatedCustomerTransferTests } from "./validated-customer-transfer.test.ts";
import { runAreaConsolidationTests } from "./area-consolidation.test.ts";
import { runLoginBridgeResyncHardeningTests } from "./login-bridge-resync-hardening.test.ts";
import { runOperationalEventsTests } from "./operational-events.test.ts";
import { runRecruitmentOnboardingMetricsTests } from "./recruitment-onboarding-metrics.test.ts";
import { runRecruitmentCandidateMatchingTests } from "./recruitment-candidate-matching.test.ts";
import { runRecruitmentPipelineStateMachineTests } from "./recruitment-pipeline-state-machine.test.ts";
import { runRecruitmentReadinessTests } from "./recruitment-readiness.test.ts";
import { runRecruitmentCvExtractionTests } from "./recruitment-cv-extraction.test.ts";
import { runProbationProvisioningTests } from "./probation-provisioning.test.ts";
import { runProbationDateTests } from "./probation-date.test.ts";
import { runProbationCaseProvisioningTests } from "./probation-case-provisioning.test.ts";
import { runProbationDomainMigrationReadinessTests } from "./probation-domain-migration-readiness.test.ts";
import { runCrmIdentityTests } from "./crm-identity.test.ts";
import { runCrmBlockCountingTests } from "./crm-block-counting.test.ts";
import { runCrmPostExitAttributionTests } from "./crm-post-exit-attribution.test.ts";
import { runCrmPreHireAttributionTests } from "./crm-pre-hire-attribution.test.ts";
import { runCrmPreHireMappingGuardTests } from "./crm-pre-hire-mapping-guard.test.ts";
import { runCrmOverrideEmploymentScopeTests } from "./crm-override-employment-scope.test.ts";
import { runCrmParitySweepTests } from "./crm-parity-sweep.test.ts";
import { runCrmSyncRunColumnsTests } from "./crm-sync-run-columns.test.ts";
import { runProbationDvSourceTests } from "./probation-dv-source.test.ts";
import { runProbationDvDetectionTests } from "./probation-dv-detection.test.ts";
import { runProbationDvValidationTests } from "./probation-dv-validation.test.ts";
import { runProbationDvPersistenceTests } from "./probation-dv-persistence.test.ts";
import { runProbationDvSyncTests } from "./probation-dv-sync.test.ts";
import { runProbationFeedbackWorkflowTests } from "./probation-feedback-workflow.test.ts";
import { runProbationAssessmentsTests } from "./probation-assessments.test.ts";
import { runProbationScoringTests } from "./probation-scoring.test.ts";
import { runProbationReportTests } from "./probation-report.test.ts";
import { runProbationDashboardTests } from "./probation-dashboard.test.ts";
import { runProbationEmailsTests } from "./probation-emails.test.ts";
import { runProbationCairoTodayConsistencyTests } from "./probation-cairo-today-consistency.test.ts";
import { runProbationNotificationControlsTests } from "./probation-notification-controls.test.ts";
import { runEmailRenderHarnessTests, runTokenRegistryConsistencyTests } from "./email-render-harness.test.ts";
import { runProbationDecisionTests } from "./probation-decision.test.ts";
import { runProbationCompletionReportTests } from "./probation-completion-report.test.ts";
import { runProbationEnhancementsPrereqTests } from "./probation-enhancements-prereq.test.ts";
import { runProbationDevActionsTests } from "./probation-dev-actions.test.ts";
import { runProbationConfigEditorTests } from "./probation-config-editor.test.ts";
import { runProbationCrmUnmappedTests } from "./probation-crm-unmapped.test.ts";
import { runProbationFeedbackInboxTests } from "./probation-feedback-inbox.test.ts";
import { runProbationOutcomesAnalyticsTests } from "./probation-outcomes-analytics.test.ts";
import { runProbationCaptureUisTests } from "./probation-capture-uis.test.ts";
import { runProbationManualScorecardTests } from "./probation-manual-scorecard.test.ts";
import { runProbationAuditFixesTests } from "./probation-audit-fixes.test.ts";
import { runProbationAuditFixesRound2Tests } from "./probation-audit-fixes-round2.test.ts";
import { runProbationLegacyWritesToCasesTests } from "./probation-legacy-writes-to-cases.test.ts";
import { runRecruitmentScorecardsTests } from "./recruitment-scorecards.test.ts";
import { runRecruitmentDriveStorageTests } from "./recruitment-drive-storage.test.ts";
import { runRecruitmentVacancyCloseInvariantTests } from "./recruitment-vacancy-close-invariant.test.ts";
import { runRecruitmentInterviewNotificationsTests } from "./recruitment-interview-notifications.test.ts";
import { runRecruitmentNsmRmCeoScopingTests } from "./recruitment-nsm-rm-ceo-scoping.test.ts";
import { runRecruitmentCvExtractionFieldsTests } from "./recruitment-cv-extraction-fields.test.ts";
import { runRecruitmentCvExtractionQualityTests } from "./recruitment-cv-extraction-quality.test.ts";
import { runRecruitmentRuleExtractionTests } from "./recruitment-rule-extraction.test.ts";
import { runRecruitmentCvAutoApplyTests } from "./recruitment-cv-auto-apply.test.ts";
import { runRecruitmentContactReviewTests } from "./recruitment-contact-review.test.ts";
import { runRecruitmentOffersTests } from "./recruitment-offers.test.ts";
import { runRecruitmentHireDraftTests } from "./recruitment-hire-draft.test.ts";
import { runRecruitmentCandidateMergeTests } from "./recruitment-candidate-merge.test.ts";
import { runRecruitmentPipelineMetricsTests } from "./recruitment-pipeline-metrics.test.ts";
import { runRecruitmentHiringManagerPushTests } from "./recruitment-hiring-manager-push.test.ts";
import { runRecruitmentSimplifyTests } from "./recruitment-simplify.test.ts";
import { runRecruitmentRequisitionPositionCatalogueTests } from "./recruitment-requisition-position-catalogue.test.ts";
import { runRecruitmentNonRecruitablePositionsTests } from "./recruitment-non-recruitable-positions.test.ts";
import { runRecruitmentManagerInboxTests } from "./recruitment-manager-inbox.test.ts";
import { runCvIntakeDigest6hTests } from "./cv-intake-digest-6h.test.ts";
import { runRecruitmentCandidatePoolTableTests } from "./recruitment-candidate-pool-table.test.ts";
import { runRecruitmentLabelTests } from "./recruitment-labels.test.ts";
import { runHiringDocumentsLabelTests } from "./hiring-documents-labels.test.ts";
import { runSearchableSelectNoEllipsisTests } from "./searchable-select-no-ellipsis.test.ts";
import { runRecruitmentAppliedForTests } from "./recruitment-applied-for.test.ts";
import { runRecruitmentManagerGroupingTests } from "./recruitment-manager-grouping.test.ts";
import { runRecruitmentCandidateSeenTests } from "./recruitment-candidate-seen.test.ts";
import { runRecruitmentScreeningPageTests } from "./recruitment-screening-page.test.ts";
import { runCandidatePositionFolderTests } from "./candidate-position-folders.test.ts";
import { runArabicPlaceMatchTests } from "./arabic-place-match.test.ts";
import { runCandidatePositionSuggestionTests } from "./candidate-position-suggestion.test.ts";
import { runRecruitmentStaleSendCheckTests } from "./recruitment-stale-send-check.test.ts";
import { runVacancyManagerEscalationTests } from "./vacancy-manager-escalation.test.ts";
import { runRecruitmentJobPostChannelTests } from "./recruitment-job-post-channels.test.ts";
import { runRecruitmentHubPortalCoverageTests } from "./recruitment-hub-portal-coverage.test.ts";
import { runRecruitmentPortalCvViewTests } from "./recruitment-portal-cv-view.test.ts";
import { runRecruitmentInboundCvIntakeTests } from "./recruitment-inbound-cv-intake.test.ts";
import { runRecruitmentIntakeFinalizePatchTests } from "./recruitment-intake-finalize-patch.test.ts";
import { runCandidateRoleRegionTests } from "./recruitment-candidate-role-region.test.ts";
import { runCandidateScreeningFactsTests } from "./recruitment-candidate-screening-facts.test.ts";
import { runCvFileChoiceTests } from "./recruitment-cv-file-choice.test.ts";
import { runRecruitmentEmployerNameTests } from "./recruitment-employer-name.test.ts";
import { runRecruitmentScreeningOrderTests } from "./recruitment-screening-order.test.ts";
import { runRecruitmentEmailIntakeTests } from "./recruitment-email-intake.test.ts";
import { runRecruitmentWhatsAppIntakeTests } from "./recruitment-whatsapp-intake.test.ts";
import { runWhatsAppSelfClassificationTests } from "./whatsapp-self-classification.test.ts";
import { runWhatsAppOwnerMirrorTests } from "./whatsapp-owner-mirror.test.ts";
import { runWhatsAppCoexistenceHistoryTests } from "./recruitment-whatsapp-coexistence-history.test.ts";
import {
  runRecruitmentWhatsAppHealthTests,
  runWhatsAppWebhookRoutingTests,
  runWhatsAppPublicReachTests,
} from "./recruitment-whatsapp-health.test.ts";
import { runRecruitmentInboundQueueTests } from "./recruitment-inbound-queue.test.ts";
import { runRecruitmentInboundMasteryTests } from "./recruitment-inbound-mastery.test.ts";
import { runRecruitmentCandidateSourceContextTests } from "./recruitment-candidate-source-context.test.ts";
import { runRecruitmentDbBatchTests } from "./recruitment-db-batch.test.ts";
import { runAttendanceCalendarSourceTests } from "./attendance-calendar-source.test.ts";
import { runEmployeeStatusFilterConsolidationTests } from "./employee-status-filter-consolidation.test.ts";
import { runAttendanceWorkingDaysTests } from "./attendance-working-days.test.ts";
import { runAttendanceCairoMidnightBoundaryTests } from "./attendance-cairo-midnight-boundary.test.ts";
import { runAttendanceTrackingEligibilityTests } from "./attendance-tracking-eligibility.test.ts";
import { runAttendanceManagerViewAccessTests } from "./attendance-manager-view-access.test.ts";
import { runAttendanceFlexibleHoursTests } from "./attendance-flexible-hours.test.ts";
import { runPayrollCopilotCycleWindowTests } from "./payroll-copilot-cycle-window.test.ts";
import { runPayrollCycleWindowRoleAwareTests } from "./payroll-cycle-window-role-aware.test.ts";
import { runAttendanceReconcileDayTests } from "./attendance-reconcile-day.test.ts";
import { runAttendanceEmployeeDayReportTests } from "./attendance-employee-day-report.test.ts";
import { runAttendanceDeviceOutageFailsafeTests } from "./attendance-device-outage-failsafe.test.ts";
import { runAttendanceSkippedPunchClassificationTests } from "./attendance-skipped-punch-classification.test.ts";
import { runAttendanceHolidayOverridesTests } from "./attendance-holiday-overrides.test.ts";
import { runDeductionsGovernanceFoundationTests } from "./deductions-governance-foundation.test.ts";
import { runDeductionsGovernanceServiceTests } from "./deductions-governance-service.test.ts";
import { runDeductionsGovernanceFwcConnectorTests } from "./deductions-governance-fwc-connector.test.ts";
import { runDeductionsGovernancePayrollImportDisabledTests } from "./deductions-governance-payroll-import-disabled.test.ts";
import { runDeductionsGovernanceCompletionTests } from "./deductions-governance-completion.test.ts";
import { runDeductionsModuleFoundationTests } from "./deductions-module-foundation.test.ts";
import { runDeductionsModulePublishTests } from "./deductions-module-publish.test.ts";
import { runDeductionsModuleCrmGuardsTests } from "./deductions-module-crm-guards.test.ts";
import { runDeductionsModulePortalTests } from "./deductions-module-portal.test.ts";
import { runDeductionsModuleSafetyTests } from "./deductions-module-safety.test.ts";
import { runDeductionsReadGateTests } from "./deductions-read-gate.test.ts";
import { runDeductionsSupersedeCarriesDecisionTests } from "./deductions-supersede-carries-decision.test.ts";
import { runDeductionsModuleAppliedDaysTests } from "./deductions-module-applied-days.test.ts";
import { runDeductionsHolidayBridgeTests } from "./deductions-holiday-bridge.test.ts";
import { runDeductionsCurrentMonthGuardTests } from "./deductions-current-month-guard.test.ts";
import { runDeductionsLeaverSettlementTests } from "./deductions-leaver-settlement.test.ts";
import { runDeductionsDsmNoRecordTests } from "./deductions-dsm-no-record.test.ts";
import { runDeductionsVacationLedgerGuardTests } from "./deductions-vacation-ledger-guard.test.ts";
import { runWeeklyPlanningFoundationTests } from "./weekly-planning-foundation.test.ts";
import { runWeeklyMonthlyPlansV1Tests } from "./weekly-monthly-plans-v1.test.ts";
import { runPlanWorkweekLinkageTests } from "./plan-workweek-linkage.test.ts";
import { runWeeklyPlansRpcContractTests } from "./weekly-plans-rpc-contract.test.ts";
import { runWeeklyPlansConcurrencyTests } from "./weekly-plans-concurrency.test.ts";
import { runWeeklyPlansHardeningTests } from "./weekly-plans-hardening.test.ts";
import { runWeeklyPlanCalendarOwnerScopeTests } from "./weekly-plan-calendar-owner-scope.test.ts";
import { runPlanningCalendarExportTests } from "./planning-calendar-export.test.ts";
import { runWeeklyPlansPermissionScopeTests } from "./weekly-plans-permission-scope.test.ts";
import { runWeeklyPlanVisibilityTests } from "./weekly-plan-visibility.test.ts";
import { runWeeklyPlansDriftCheckTests } from "./weekly-plans-drift-check.test.ts";
import { runWeeklyPlanManagerGapTests } from "./weekly-plan-manager-gap.test.ts";
import { runWeeklyPlanRegionAreasTests } from "./weekly-plan-region-areas.test.ts";
import { runPlanAdherenceTests } from "./plan-adherence.test.ts";
import { runActionCenterWeeklyPlansTests } from "./action-center-weekly-plans.test.ts";
import { runWeeklyPlansRound3FeaturesTests } from "./weekly-plans-round3-features.test.ts";
import { runDoubleVisitAnalyticsTests } from "./double-visit-analytics.test.ts";
import { runDoubleVisitReportExportTests } from "./double-visit-report-export.test.ts";
import { runDvPlannerWeeklyDigestTests } from "./dv-planner-weekly-digest.test.ts";
import { runDvPlannerDateCheckTests } from "./dv-planner-date-check.test.ts";
import { runVisitsReportSyncTests } from "./visits-report-sync.test.ts";
import { runCrmCallRateTests } from "./crm-call-rate.test.ts";
import { runCrmRepsPlansTests } from "./crm-reps-plans.test.ts";
import { runCrmRepVisitsTests } from "./crm-rep-visits.test.ts";
import { runCrmRegionBrickSuggestTests } from "./crm-region-brick-suggest.test.ts";
import { runCrmRepsPlansPeriodTests } from "./crm-reps-plans-period.test.ts";
import { runCrmCampaignNoteTests } from "./crm-campaign-note.test.ts";
import { runCrmCampaignContactMatchTests } from "./crm-campaign-contact-match.test.ts";
import { runCrmCheckinMatchTests } from "./crm-checkin-match.test.ts";
import { runCrmCheckinPageBoundaryTests } from "./crm-checkin-page-boundary.test.ts";
import { runCrmVacationDurationTests } from "./crm-vacation-duration.test.ts";
import { runCrmIntegrityCorrelationTests } from "./crm-integrity-correlation.test.ts";
import { runCrmSingleSourceTests } from "./crm-single-source.test.ts";
import { runCrmSyncIdentityPreservationTests } from "./crm-sync-identity-preservation.test.ts";
import { runCrmVisitTimeTests } from "./crm-visit-time.test.ts";
import { runCrmReadsHrIdCasingTests } from "./crm-reads-hrid-casing.test.ts";
import { runCrmVisitsSelfScopeTests } from "./crm-visits-self-scope.test.ts";
import { runCrmLiveSyncWindowTests } from "./crm-live-sync-window.test.ts";
import { runCrmLivePollerTests } from "./crm-live-poller.test.ts";
import { runCrmDuplicateVisitCollapseTests } from "./crm-duplicate-visit-collapse.test.ts";
import { runCrmMasterExportWorkbookTests } from "./crm-master-export-workbook.test.ts";
import { runCrmDegradationPolicyTests } from "./crm-degradation-policy.test.ts";
import { runCrmCoverageFilterTests } from "./crm-coverage-filters.test.ts";
import { runCrmCheckinCoordGuardTests } from "./crm-checkin-coord-guard.test.ts";
import { runCrmAmpmNormalizationTests } from "./crm-ampm-normalization.test.ts";
import { runCrmVisitTypeLabelTests } from "./crm-visit-type-labels.test.ts";
import { runCrmRepDoctorListsTests } from "./crm-rep-doctor-lists.test.ts";
import { runCrmRepDoctorTrendTests } from "./crm-rep-doctor-trend.test.ts";
import { runLocationIqGeocodeConfidenceTests } from "./locationiq-geocode-confidence.test.ts";
import { runPrivateCalendarTests } from "./private-calendar.test.ts";
import { runWeeklyPlanApproverUiParityTests } from "./weekly-plan-approver-ui-parity.test.ts";
import { runWeeklyPlanMovePeriodTests } from "./weekly-plan-move-period.test.ts";
import { runTerminationTruthTests } from "./termination-truth.test.ts";
import { runResignationCompletionVacancyTests } from "./resignation-completion-vacancy.test.ts";
import { runCairoLeaveTodayTests } from "./cairo-leave-today.test.ts";
import { runCairoPeriodSeedGuardTests } from "./cairo-period-seed-guard.test.ts";
import { runIdentityAliasesTests } from "./identity-aliases.test.ts";
import { runFieldWorkforceComplianceTests } from "./field-workforce-compliance.test.ts";
import { runFieldWorkforceComplianceEligibilityTests } from "./field-workforce-compliance-eligibility.test.ts";
import { runFieldWorkforceComplianceLiveSnapshotsTests } from "./field-workforce-compliance-live-snapshots.test.ts";
import { runFieldWorkforceComplianceScorecardsTests } from "./field-workforce-compliance-scorecards.test.ts";
import { runCompanyVacationReportTests } from "./company-vacation-report.test.ts";
import { runSfeVacationSourceReportTests } from "./sfe-vacation-source-report.test.ts";
import { runNsmTeamCalendarTests } from "./nsm-team-calendar.test.ts";
import { runCompanyHolidaysTests } from "./company-holidays.test.ts";
import { runLeaveSourceOfTruthTests } from "./leave-source-of-truth.test.ts";
import { runLifecycleRiskSourceTests } from "./lifecycle-risk-source.test.ts";
import { runLoginPageHardeningTests } from "./login-page-hardening.test.ts";
import { runCommunicationSourceOfTruthTests } from "./communication-source-of-truth.test.ts";
import { runCoachingScoringTests } from "./coaching-scoring.test.ts";
import { runCoachingAnalyticsTests } from "./coaching-analytics.test.ts";
import { runCoachingExcelExportTests } from "./coaching-excel-export.test.ts";
import { runCoachingImportTests } from "./coaching-import.test.ts";
import { runCoachingAccessScopeTests } from "./coaching-access-scope.test.ts";
import { runCoachingDateFormattingTests } from "./coaching-date-formatting.test.ts";
import { runSalesOthersBucketTests } from "./sales-others-bucket.test.ts";
import { runSalesRoleMappingTests } from "./sales-role-mapping.test.ts";
import { runSalesPeriodTests } from "./sales-period.test.ts";
import { runSalesSourceOfTruthTests } from "./sales-source-of-truth.test.ts";
import { runSosMonthlyReportCheckTests } from "./sos-monthly-report-check.test.ts";
import { runSalesDistributorImportTests } from "./sales-distributor-import.test.ts";
import { runCustomerNormalizeTests } from "./customer-normalize.test.ts";
import { runPharmacyGeoValidateTests } from "./pharmacy-geo-validate.test.ts";
import { runCustomerPropagationTests } from "./customer-propagation.test.ts";
import { runSosAutoApplyTests } from "./sos-auto-apply.test.ts";
import { runCustomerClustersTests } from "./customer-clusters.test.ts";
import { runWeeklySalesImportTests } from "./weekly-sales-import.test.ts";
import { runWeeklySalesAccessTests } from "./weekly-sales-access.test.ts";
import { runMonthlyClosingRegionScopeTests } from "./monthly-closing-region-scope.test.ts";
import { runMonthlyClosingDetailsTests } from "./monthly-closing-details.test.ts";
import { runSalesRestrictedProductsTests } from "./sales-restricted-products.test.ts";
import { runAuTargetsValidationTests } from "./au-targets-validation.test.ts";
import { runTargetsTemplateRoundtripTests } from "./targets-template-roundtrip.test.ts";
import { runEmployee360ExpenseRoleTests } from "./employee-360-expense-role.test.ts";
import { runEmployee360SalesMaskingTests } from "./employee-360-sales-masking.test.ts";
import { runEmployee360RoleCategoryTests } from "./employee-360-role-category.test.ts";
import { runEmployee360WorkweekTests } from "./employee-360-workweek.test.ts";
import { runEmployee360AccessTests } from "./employee-360-access.test.ts";
import { runEmployee360PortalBrowseTests } from "./employee-360-portal-browse.test.ts";
import { runWeeklyColumnContractTests } from "./weekly-column-contract.test.ts";
import { runSosCustomerMapBrickFillTests } from "./sos-customer-map-brick-fill.test.ts";
import { runCustomerDirectoryTests } from "./customer-directory.test.ts";
import { runCustomerMappingTests } from "./sales-customer-mapping.test.ts";
import { runMonthlyClosingComparisonTests } from "./monthly-closing-comparison.test.ts";
import { runMonthlyClosingExportScopeTests } from "./monthly-closing-export-scope.test.ts";
import { runPortalClosingLineChoiceTests } from "./portal-closing-line-choice.test.ts";
import { runClosingOrganogramRegionsTests } from "./closing-organogram-regions.test.ts";
import { runDirectChannelTests } from "./direct-channel.test.ts";
import { runDirectOrdersLandOnTheirOwnAreaTests } from "./direct-orders-land-on-their-own-area.test.ts";
import { runSosResolveBrickPrecedenceTests } from "./sos-resolve-brick-precedence.test.ts";
import { runSosBrickCoverageTests } from "./sos-brick-coverage.test.ts";
import { runSosCrosswalkPaginationTests } from "./sos-crosswalk-pagination.test.ts";
import { runSosCustomerMapKeysetTests } from "./sos-customer-map-keyset.test.ts";
import { runSosAmbiguousAliasTests } from "./sos-ambiguous-alias.test.ts";
import { runSosNormalizerTests } from "./sos-normalizer.test.ts";
import { runSalesRecognizeTests } from "./sales-recognize.test.ts";
import { runSalesDistributorRegistryTests } from "./sales-distributor-registry.test.ts";
import { runSalesProfilesTests } from "./sales-profiles.test.ts";
import { runSalesMasterDataPaginationTests } from "./sales-master-data-pagination.test.ts";
import { runSalesMasterDataEditDeleteTests } from "./sales-master-data-edit-delete.test.ts";
import { runSalesBrickRelocateTests } from "./sales-brick-relocate.test.ts";
import { runDistributorProfileStoreTests } from "./sales-distributor-profile-store.test.ts";
import { runWeeklyColumnProfileStoreTests } from "./weekly-column-profile-store.test.ts";
import { runWeeklyDecumulationTests } from "./weekly-decumulation.test.ts";
import { runWeeklyBatchScopeTests } from "./weekly-batch-scope.test.ts";
import { runWeeklyBranchAreaSplitTests } from "./weekly-branch-area-split.test.ts";
import { runWeeklyBranchAttributionTests } from "./weekly-branch-attribution.test.ts";
import { runWeeklyBranchNameScopeTests } from "./weekly-branch-name-scope.test.ts";
import { runWeeklyTrackedLinesScopeTests } from "./weekly-tracked-lines-scope.test.ts";
import { runWeeklySummaryReportTests } from "./weekly-summary-report.test.ts";
import { runWeeklyMonthTargetScopeTests } from "./weekly-month-target-scope.test.ts";
import { runSalesRawTemplateTests } from "./sales-raw-template.test.ts";
import { runSalesMappingDatabaseTests } from "./sales-mapping-database.test.ts";
import { runSalesUploadReconcileTests } from "./sales-upload-reconcile.test.ts";
import { runSalesUploadValidationTests } from "./sales-upload-validation.test.ts";
import { runSalesUploadVerificationTests } from "./sales-upload-verification.test.ts";
import { runSalesAiExplainTests } from "./sales-ai-explain.test.ts";
import { runSalesLinkageTests } from "./sales-linkage.test.ts";
import { runSosCustomerKeyTests } from "./sos-customer-key.test.ts";
import { runSosCodeCanonicalTests } from "./sos-code-canonical.test.ts";
import { runSalesPharmacyOverrideTests } from "./sales-pharmacy-override.test.ts";
import { runSalesChannelsByRepTests } from "./sales-channels-by-rep.test.ts";
import { runSosNormalizerPersistShapeTests } from "./sos-normalizer-persist-shape.test.ts";
import { runSosImportTemplateTests } from "./sos-import-template.test.ts";
import { runImportPreviewTests } from "./import-preview.test.ts";
import { runEmployeeImportTeamResurrectionGuardTests } from "./employee-import-team-resurrection-guard.test.ts";
import { runOrgTitleCaseAcronymTests } from "./org-title-case-acronyms.test.ts";
import { runImportsLineCanonicalizationTests } from "./imports-line-canonicalization.test.ts";
import { runImportTeamBlankWarningTests } from "./import-team-blank-warning.test.ts";
import { runDetectDistributorTests } from "./detect-distributor.test.ts";
import { runDistributorDetectionHeaderRowTests } from "./distributor-detection-header-row.test.ts";
import { runDistributorHeaderNormalizationTests } from "./sales-header-normalize.test.ts";
import { runBrickSuggestionsTests } from "./brick-suggestions.test.ts";
import { runImportCoverageTests } from "./import-coverage.test.ts";
import { runOfficePivotTests } from "./office-pivot.test.ts";
import { runOfficeAllocationTests } from "./office-allocation.test.ts";
import { runOfficeGoldenRuleLockTests } from "./office-golden-rule-lock.test.ts";
import { runClosingOfficeDifferentiationTests } from "./closing-office-differentiation.test.ts";
import { runOfficeColumnIsCnsOnlyTests } from "./office-column-is-cns-only.test.ts";
import { runSosEvenSplitEzTests } from "./sos-even-split-ez.test.ts";
import { runClosingMatrixFoldTests } from "./closing-matrix-fold.test.ts";
import { runMasterWorkbookKeysetTests } from "./master-workbook-keyset.test.ts";
import { runSalesVsTargetCacheTests } from "./sales-vs-target-cache.test.ts";
import { runBusinessReviewAchievementArithmeticTests } from "./business-review-achievement-arithmetic.test.ts";
import { runTargetsRollupAchievementTests } from "./targets-rollup-achievement.test.ts";
import { runBusinessReviewPortalScopeTests } from "./business-review-portal-scope.test.ts";
import { runBusinessReviewWindowAndCoverageTests } from "./business-review-window-and-coverage.test.ts";
import { runMonthlySalesRunTests } from "./monthly-sales-run.test.ts";
import { runSosHeaderDetectionTests } from "./sos-header-detection.test.ts";
import { runSalesStrictConformanceTests } from "./sales-strict-conformance.test.ts";
import { runSalesRoiBatchDedupTests } from "./sales-roi-batch-dedup.test.ts";
import { runSosAtomicFinalizeTests } from "./sos-atomic-finalize.test.ts";
import { runSosHeaderAliasesTests } from "./sos-header-aliases.test.ts";
import { runSosGuardrailsTests } from "./sos-guardrails.test.ts";
import { runSosWarningCleanupTests } from "./sos-warning-cleanup.test.ts";
import { runCustomerMapImportTests } from "./customer-map-import.test.ts";
import { runMarketingManagerRoleTests } from "./marketing-manager-role.test.ts";
import { runMarketingMasterResolutionTests } from "./marketing-master-resolution.test.ts";
import { runMarketingReferenceImporterTests } from "./marketing-reference-importer.test.ts";
import { runMarketingRequestAccessTests } from "./marketing-request-access.test.ts";
import { runMarketingRequestServiceTests } from "./marketing-request-service.test.ts";
import { runMarketingValidationDraftTests } from "./marketing-validation-draft.test.ts";
import { runMarketingVenueTerritoryTests } from "./marketing-venue-territory.test.ts";
import { runReportRpcGuardrailTests } from "./report-rpc-guardrails.test.ts";
import { runMarketingReviewRoutingTests } from "./marketing-review-routing.test.ts";
import { runMarketingApproverHrIdCasingTests } from "./marketing-approver-hrid-casing.test.ts";
import { runMarketingSuperAdminOversightTests } from "./marketing-super-admin-oversight.test.ts";
import { runMarketingApprovalHistoryTabTests } from "./marketing-approval-history-tab.test.ts";
import { runMarketingInboxDecisionBarGatingTests } from "./marketing-inbox-decision-bar-gating.test.ts";
import { runMarketingInboxWorkspaceLayoutTests } from "./marketing-inbox-workspace-layout.test.ts";
import { runMarketingPremiumNotificationTests } from "./marketing-premium-notifications.test.ts";
import { runMarketingRoiTests } from "./marketing-roi.test.ts";
import { runMarketingRoiSheetImportTests } from "./marketing-roi-sheet-import.test.ts";
import { runMarketingRoiReportScopeTests } from "./marketing-roi-report-scope.test.ts";
import { runMarketingRoiReportHelpersTests } from "./marketing-roi-report-helpers.test.ts";
import { runMarketingRoiLabelingTests } from "./marketing-roi-labeling.test.ts";
import { runMarketingRequestOverlapTests } from "./marketing-request-overlap.test.ts";
import { runMarketingRoiConfidenceTests } from "./marketing-roi-confidence.test.ts";
import { runMarketingRoiLiveStagesTests } from "./marketing-roi-live-stages.test.ts";
import { runMarketingSubmissionCaptureGateTests } from "./marketing-submission-capture-gates.test.ts";
import { runNurseryVenueTypeTests } from "./nursery-venue-type.test.ts";
import { runVenueTypeMustBeAskedTests } from "./venue-type-must-be-asked.test.ts";
import { runVenueValidationRuleTests } from "./venue-validation-rule.test.ts";
import { runMarketingVenueMergeTests } from "./marketing-venue-merge.test.ts";
import { runMarketingVenueMergeRouteTests } from "./marketing-venue-merge-route.test.ts";
import { runMarketingRoiTrackerTests } from "./marketing-roi-tracker.test.ts";
import { runMarketingRoiExplainTests } from "./marketing-roi-explain.test.ts";
import { runMarketingRoiBusinessReportTests } from "./marketing-roi-business-report.test.ts";
import { runPharmacyMatchingTests } from "./pharmacy-matching.test.ts";
import { runMarketingRoiFacetsTests } from "./marketing-roi-facets.test.ts";
import { runMarketingRoiExportWorkbookTests } from "./marketing-roi-export-workbook.test.ts";
import { runMarketingRoiAttributionConsistencyTests } from "./marketing-roi-attribution-consistency.test.ts";
import { runMarketingRoiActualsToggleParityTests } from "./marketing-roi-actuals-toggle-parity.test.ts";
import {
  runMarketingCoverageReportAccessTests,
  runMarketingCoverageReportReachabilityTests,
} from "./marketing-coverage-report-access.test.ts";
import { runMarketingCoverageReportScopeTests } from "./marketing-coverage-report-scope.test.ts";
import { runMarketingCoverageActualsReliabilityTests } from "./marketing-coverage-actuals-reliability.test.ts";
import { runMarketingCoverageReportRoleParityTests } from "./marketing-coverage-report-role-parity.test.ts";
import { runMarketingCoverageFacetsTests } from "./marketing-coverage-facets.test.ts";
import { runMarketingCoveragePharmacyMergeTests, runMarketingCoverageGroupSalesDetailTests } from "./marketing-coverage-pharmacy-merge.test.ts";
import { runMarketingCoverageKpiExtensionTests } from "./marketing-coverage-kpi-extension.test.ts";
import { runMarketingCoveragePresetMigrationReadinessTests } from "./marketing-coverage-preset-migration-readiness.test.ts";
import { runMarketingCoverageExportWorkbookTests } from "./marketing-coverage-export-workbook.test.ts";
import { runMarketingCoverageReportAnalyticsTests } from "./marketing-coverage-report-analytics.test.ts";
import { runMarketingCoverageDistributorRollupTests } from "./marketing-coverage-distributor-rollup.test.ts";
import { runMarketingCoverageUrlStateTests } from "./marketing-coverage-url-state.test.ts";
import { runWeeklyExportTests } from "./weekly-export-workbook.test.ts";
import { runMarketingValidationServiceTests } from "./marketing-validation-service.test.ts";
import { runMarketingCompleteExistingCustomerTests } from "./marketing-complete-existing-customer.test.ts";
import { runMarketingCompleteExistingVenueTests } from "./marketing-complete-existing-venue.test.ts";
import { runMarketingGovernorateCheckTests } from "./marketing-governorate-check.test.ts";
import { runMarketingValidationPharmacyCardMinWidthTests } from "./marketing-validation-pharmacy-card-min-width.test.ts";
import { runMarketingEvidencePhotoStorageTests } from "./marketing-evidence-photo-storage.test.ts";
import { runPharmacyLicenseEvidenceTests } from "./pharmacy-license-evidence.test.ts";
import { runMarketingPharmacyLicenseVerdictTests } from "./marketing-pharmacy-license-verdict.test.ts";
// Registered beside its marketing siblings rather than appended at the end of the file: this
// one pins the daily nudge to the SAME rule the badge draws, so a PR editing either sees both.
import { runMarketingFieldCaptureBacklogTests } from "./marketing-field-capture-backlog.test.ts";
import { runSupportRequestsNotificationsTests } from "./support-requests-notifications.test.ts";
import { runOrganogramEmptyDiagnosticTests } from "./organogram-empty-diagnostic.test.ts";
import { runPositionVacancyStatusIntegrityTests } from "./position-vacancy-status-integrity.test.ts";
import { runReconcileStaleVacancyAreaGuardTests } from "./reconcile-stale-vacancy-area-guard.test.ts";
import { runSalaryAllowancePolicyTests } from "./salary-allowance-policy.test.ts";
import { runWorkforceClassificationTests } from "./workforce-classification.test.ts";
import { runWorkforceLifecycleSeatTests } from "./workforce-lifecycle-seat.test.ts";
import { runWorkforceHierarchyContinuityTests } from "./workforce-hierarchy-continuity.test.ts";
import { runPerformanceReconciliationTests } from "./performance-reconciliation.test.ts";
import { runHrIdAliasNormalizationTests } from "./hrid-alias-normalization.test.ts";
import { runPayrollLifecycleScopeTests } from "./payroll-lifecycle-scope.test.ts";
import { runOfferVacancyMatchingTests } from "./offer-vacancy-matching.test.ts";
import { runNotificationRecipientIsolationTests } from "./notification-recipient-isolation.test.ts";
import { runWorkflowControlTests } from "./workflow-control.test.ts";
import { runWorkflowControlGovernanceTests } from "./workflow-control-governance.test.ts";
import { runWorkflowControlMigrationReadinessTests } from "./workflow-control-migration-readiness.test.ts";
import { runWorkflowControlServicesTests } from "./workflow-control-services.test.ts";
import { runWorkflowControlApiRoutesTests } from "./workflow-control-api-routes.test.ts";
import { runEmployeePortalSalesScopeTests } from "./employee-portal-sales-scope.test.ts";
import { runCoachingPermissionTests } from "./coaching-permissions.test.ts";
import { runCoachingInAppNotificationTests } from "./coaching-in-app-notifications.test.ts";
import { runRlsGapClosureTests } from "./rls-gap-closure.test.ts";
import { runOutstationCarEvidenceValidationTests } from "./outstation-car-evidence-validation.test.ts";
import { runOutstationExpenseExportTests } from "./outstation-expense-export.test.ts";
import { runOutstationLocalDraftTests } from "./outstation-local-draft.test.ts";
import { runOutstationPayrollExpenseMappingTests } from "./outstation-payroll-expense-mapping.test.ts";
import { runOutstationImportIsAdditiveTests } from "./outstation-import-is-additive.test.ts";
import { runSalaryRecordsUniqueBatchHrTests } from "./salary-records-unique-batch-hr.test.ts";
import { runOutstationPolicyClassificationTests } from "./outstation-policy-classification.test.ts";
import { runOutstationNotificationsTests } from "./outstation-notifications.test.ts";
import { runGeocodePrecisionTests } from "./geocode-precision.test.ts";
import { runOutstationDistanceFailureTests } from "./outstation-distance-failure.test.ts";
import { runOutstationEmployeeLookupStatusTests } from "./outstation-employee-lookup-status.test.ts";
import { runMedicalRepExpensesTests } from "./medical-rep-expenses.test.ts";
import { runAuthSessionTests } from "./auth-session.test.ts";
import { runAuthPageAccessTests } from "./auth-page-access.test.ts";
import { runLoginPageServerRenderTests } from "./login-page-server-render.test.ts";
import { runAuthAuditHardeningTests } from "./auth-audit-hardening.test.ts";
import { runEmployeeDisplayNameTests } from "./employee-display-name.test.ts";
import { runEmployeeImportHrIdAliasResolutionTests } from "./employee-import-hrid-alias-resolution.test.ts";
import { runEmployeeImportNicknameGuardTests } from "./employee-import-nickname-guard.test.ts";
import { runEmployeeImportSeatValidationTests } from "./employee-import-seat-validation.test.ts";
import { runEmployeeImportLifecycleTests } from "./employee-import-lifecycle.test.ts";
import { runEmployeeRegionResolverTests } from "./employee-region-resolver.test.ts";
import { runEmployeeRecordHealthTests } from "./employee-record-health.test.ts";
import { runEmployeeSalaryDetailsTests } from "./employee-salary-details.test.ts";
import { runResignationDateEditTests } from "./resignation-date-edit.test.ts";
import { runResignationsDashboardScopeTests } from "./resignations-dashboard-scope.test.ts";
import { runResignationsCairoTodayTests } from "./resignations-cairo-today.test.ts";
import { runResignationSubmittedByFkTests } from "./resignation-submitted-by-fk.test.ts";
import { runResignationCrmIdentityReleaseTests } from "./resignation-crm-identity-release.test.ts";
import { runProbationFeedbackRevivalTests } from "./probation-feedback-revival.test.ts";
import { runAccessProfileHrIdCasingTests } from "./access-profile-hrid-casing.test.ts";
import { runEmployeePortalNavigationTests } from "./employee-portal-navigation.test.ts";
import { runPortalNavActingDmUsesAppRoleTests } from "./portal-nav-acting-dm-uses-app-role.test.ts";
import { runEmployeePortalBottomNavTests } from "./employee-portal-bottom-nav.test.ts";
import { runEmployeePortalNavCatalogSyncTests } from "./employee-portal-nav-catalog-sync.test.ts";
import { runCompanyCalendarTests } from "./company-calendar.test.ts";
import { runPortalLoggingTests } from "./portal-logging.test.ts";
import { runScopeBadgeTests } from "./scope-badge.test.ts";
import { runEmployeePortalPayslipSalaryTests } from "./employee-portal-payslip-salary.test.ts";
import { runAdminPayslipImageExportTests } from "./admin-payslip-image-export.test.ts";
import { runEmployeePayrollEligibilityTests } from "./employee-payroll-eligibility.test.ts";
import { runEmployeeAccessProvisioningTests } from "./employee-access-provisioning.test.ts";
import { runHrFunctionGovernanceTests } from "./hr-function-governance.test.ts";
import { runHrClearanceRetentionTests } from "./hr-clearance-retention.test.ts";
import { runHrCommandCenterTests } from "./hr-command-center.test.ts";
import { runHrSeatRouteCoherenceTests } from "./hr-seat-route-coherence.test.ts";
import { runTitlePermissionGovernanceTests } from "./title-permission-governance.test.ts";
import { runOrganogramHardeningTests } from "./organogram-hardening.test.ts";
import { runVacancyReportOrganogramConsistencyTests } from "./vacancy-report-organogram-consistency.test.ts";
import { runOrganogramGodmodeTests } from "./organogram-godmode.test.ts";
import { runOrganogramHeadOfficeBranchTests } from "./organogram-head-office-branch.test.ts";
import { runOrganogramHeadOfficeMarketingAndOpenSeatsTests } from "./organogram-head-office-marketing-and-open-seats.test.ts";
import { runOrganogramLinePickerHeadOfficeTests } from "./organogram-line-picker-offers-head-office.test.ts";
import { runOrganogramPhantomSeatSuppressionTests } from "./organogram-phantom-seat-suppression.test.ts";
import { runVacancyReportSourceTests } from "./vacancy-report-source.test.ts";
import { runOrganogramNodeDetailPrivacyTests } from "./organogram-node-detail-privacy.test.ts";
import { runOrganogramAudienceTests } from "./organogram-audience.test.ts";
import { runProbationStabilizationTests } from "./probation-stabilization.test.ts";
import { runProbationFeedbackSecurityTests } from "./probation-feedback-security.test.ts";
import { runGoogleRoutesShortestTests } from "./google-routes-shortest.test.ts";
import { runAccessGovernanceHardeningTests } from "./access-governance-hardening.test.ts";
import { runRlsAuthenticatedReadRevokeTests } from "./rls-authenticated-read-revoke.test.ts";
import { runAccessIdentityHardeningTests } from "./access-identity-hardening.test.ts";
import { runAccessRegistryCoverageTests } from "./access-registry-coverage.test.ts";
import { runPayrollMutationAuditTests } from "./payroll-mutation-audit.test.ts";
import { runVacationRetentionPurgeAuditTests } from "./vacation-retention-purge-audit.test.ts";
import { runCronControlRegistryTests } from "./cron-control-registry.test.ts";
import { runCronControlExpressionTests } from "./cron-control-expression.test.ts";
import { runNotificationRoleRecipientsTests } from "./notification-role-recipients.test.ts";
import { runEmailControlCenterTests } from "./email-control-center.test.ts";
import { runWorkflowRegistryTests } from "./workflow-registry.test.ts";
import { runWorkflowRegistryEnforcementTests } from "./workflow-registry-enforcement.test.ts";
import { runApprovalsHubTests } from "./approvals-hub.test.ts";
import { runNotificationAutoArchiveTests } from "./notification-auto-archive.test.ts";
import { runVacationApprovalFlowTests } from "./vacation-approval-flow.test.ts";
import { runVacationCalculationTests } from "./vacation-calculations.test.ts";
import { runVacationModuleTests } from "./vacation-module.test.ts";
import { runVacationCairoTodayTests } from "./vacation-cairo-today.test.ts";
import { runVacationPaidApprovalAtomicTests } from "./vacation-paid-approval-atomic.test.ts";
import { runVacationOverlapWarningsTests } from "./vacation-overlap-warnings.test.ts";
import { runVacationReportFilterEquivalenceTests } from "./vacation-report-filter-equivalence.test.ts";
import { runCsrfRouteCoverageTests } from "./csrf-route-coverage.test.ts";
import { runContractRenewalHardeningTests } from "./contract-renewal-hardening.test.ts";
import { runContractNonRenewalTerminalTests } from "./contract-non-renewal-terminal.test.ts";
import { runContractNonRenewalMigrationReadinessTests } from "./contract-non-renewal-migration-readiness.test.ts";
import { runResignationScopeCheckTests } from "./resignation-scope-check.test.ts";
import { runResignationWorkflowScopeCheckTests } from "./resignation-workflow-scope-check.test.ts";
import { runContractRenewalWorkflowScopeCheckTests } from "./contract-renewal-workflow-scope-check.test.ts";
import { runCustomerPharmacyMappingReadinessTests } from "./customer-pharmacy-mapping-readiness.test.ts";
import { runCustomerPharmacyMappingActionsTests } from "./customer-pharmacy-mapping-actions.test.ts";
import { runCvDatabaseTests } from "./cv-database.test.ts";
import { runTransactionWorkflowAuditTests } from "./transaction-workflow-audit.test.ts";
import { runPhase13BrowserSmokeRegressionTests } from "./phase13-browser-smoke-regression.test.ts";
import { runPhase14ControlledMutationSmokeTests } from "./phase14-controlled-mutation-smoke.test.ts";
import { runPhase15DisposableFixtureSmokeTests } from "./phase15-disposable-fixture-smoke.test.ts";
import { runPhase16ProductionGapBurndownTests } from "./phase16-production-gap-burndown.test.ts";
import { runPhase17WorkflowUiActionClosureTests } from "./phase17-workflow-ui-action-closure.test.ts";
import { runPhase18FixtureHygieneTests } from "./phase18-fixture-hygiene.test.ts";
import { runPhase19FixtureCleanupTests } from "./phase19-fixture-cleanup.test.ts";
import { runPhase20ProductionReadinessTests } from "./phase20-production-readiness.test.ts";
import { runPhase21SecurityHardeningTests } from "./phase21-security-hardening.test.ts";
import { runPhase22RoleMatrixSecurityTests } from "./phase22-role-matrix-security.test.ts";
import { runCeoOrganogramVisibilityTests } from "./ceo-organogram-visibility.test.ts";
import { runOrganogramWhatsAppNumberTests } from "./organogram-whatsapp-number.test.ts";
import { runOrganogramWhatsAppGateTests } from "./organogram-whatsapp-gate.test.ts";
import { runCeoCommandCenterTests } from "./ceo-command-center.test.ts";
import { runPhase23BrowserRoleWalkthroughTests } from "./phase23-browser-role-walkthrough.test.ts";
import { runPhase24RealAuthRlsApiSmokeTests } from "./phase24-real-auth-rls-api-smoke.test.ts";
import { runPhase25StagingRlsMutationSmokeTests } from "./phase25-staging-rls-mutation-smoke.test.ts";
import { runPhase26StagingBrowserAuthMutationSmokeTests } from "./phase26-staging-browser-auth-mutation-smoke.test.ts";
import { runPhase27StagingAppServiceMutationSmokeTests } from "./phase27-staging-app-service-mutation-smoke.test.ts";
import { runPhase28ProductionMigrationReadinessTests } from "./phase28-production-migration-readiness.test.ts";
import { runPhase29ProductionMigrationPreapplyReviewTests } from "./phase29-production-migration-preapply-review.test.ts";
import { runPhase30ProductionMigrationApprovalGateTests } from "./phase30-production-migration-approval-gate.test.ts";
import { runPhase32ProductionMigrationQueueReviewTests } from "./phase32-production-migration-queue-review.test.ts";
import { runPhase33MigrationHistoryReconciliationGateTests } from "./phase33-migration-history-reconciliation-gate.test.ts";
import { runStagingExecutiveDashboardMigrationReconciliationTests } from "./staging-executive-dashboard-migration-reconciliation.test.ts";
import { runStagingSafeRebuildTests } from "./staging-safe-rebuild.test.ts";
import { runEmailProductionReadinessTests } from "./email-production-readiness.test.ts";
import { runEmailP0TestingTrapTests } from "./email-p0-testing-trap.test.ts";
import { runEmailEngineHardeningTests } from "./email-engine-hardening.test.ts";
import { runEmailSendHardeningTests } from "./email-send-hardening.test.ts";
import { runAdminTelegramMirrorTests } from "./admin-telegram-mirror.test.ts";
import { runEmailProviderFailoverTests } from "./email-provider-failover.test.ts";
import { runBrevoWebhookEventsTests } from "./brevo-webhook-events.test.ts";
import { runEmailActivityTests } from "./email-activity.test.ts";
import { runEmailTemplatesTriggersTests } from "./email-templates-triggers.test.ts";
import { runEmailFollowupsTests } from "./email-followups.test.ts";
import { runReportItAccessTests } from "./report-it-access.test.ts";
import { runSosInvoiceDateTests } from "./sos-invoice-date.test.ts";
import { runSystemCleanupCenterTests } from "./system-cleanup-center.test.ts";
import { runExcusesTests } from "./excuses.test.ts";
import { runExcuseManagerGapTests } from "./excuse-manager-gap.test.ts";
import { runExpenseAccessScopeTests } from "./expense-access-scope.test.ts";
import { runSalesPayrollHierarchyScopeTests } from "./sales-payroll-hierarchy-scope.test.ts";
import { runInternalMessagesTests } from "./internal-messages.test.ts";
import { runOriginConfigSingleSourceTests } from "./origin-config-single-source.test.ts";
import { runGcloudMigrationHardeningTests } from "./gcloud-migration-hardening.test.ts";
import { runEmployeePortalFingerprintVisibilityTests } from "./employee-portal-fingerprint-visibility.test.ts";
import { runPostgrestArrayFilterGuardTests } from "./postgrest-array-filter-guard.test.ts";
import { runActivityTrackingTests } from "./activity-tracking.test.ts";
import { runActivityManagerViewAccessTests } from "./activity-manager-view-access.test.ts";
import { runAttendanceSelfScopeTests } from "./attendance-self-scope.test.ts";
import { runAttendanceExceptionNotesTests } from "./attendance-exception-notes.test.ts";
import { runHiringDocumentCaptureTests } from "./hiring-document-capture.test.ts";
import { runHiringDocumentsAccessTests } from "./hiring-documents-access.test.ts";
import { runHiringDocumentsAuditTests } from "./hiring-documents-audit.test.ts";
import { runHiringDocumentsDeadlineTests } from "./hiring-documents-deadline.test.ts";
import { runHiringDocumentsStatusNotesTests } from "./hiring-documents-status-notes.test.ts";
import { runHiringPackTests } from "./hiring-pack.test.ts";
import { runOfferBuiltinTemplateTests } from "./offer-builtin-templates.test.ts";
import { runOfferLetterPayAndRenderTests } from "./offer-letter-pay-and-render.test.ts";
import { runOfferPdfRuntimeTests } from "./offer-pdf-runtime.test.ts";
import { runOfferDatesTests } from "./offer-dates.test.ts";
import { runOfferDraftCheckTests } from "./offer-draft-checks.test.ts";
import { runOfferPlaceholderTests } from "./offer-placeholders.test.ts";
import { runOfferReferenceTests } from "./offer-reference.test.ts";
import { runOfferTitleTemplateTests } from "./offer-title-template.test.ts";
import { runSalesNullVsZeroTests } from "./sales-null-vs-zero.test.ts";
import { runSosAnalyticsTests } from "./sos-analytics.test.ts";
import { runSosBiWorkbookTests } from "./sos-bi-workbook.test.ts";
import { runMonthlyDashboardWorkbookTests } from "./monthly-dashboard-workbook.test.ts";
import { runCustomerDirectoryRollupTests } from "./customer-directory-rollup.test.ts";
import { runWeeklySalesPaginationTests } from "./weekly-sales-pagination.test.ts";
import { runNavBadgeStoreTests } from "./nav-badge-store.test.ts";
import { runAnalyticsValidationTests } from "./analytics-validation.test.ts";
import { runAnalyticsMetabaseEmbedTests } from "./analytics-metabase-embed.test.ts";
import { runAnalyticsFilterIndependenceTests } from "./analytics-filter-independence.test.ts";
import { runPortalSosScopeTests } from "./portal-sos-scope.test.ts";
import { runDmSeatAreaScopeTests } from "./dm-seat-area-scope.test.ts";
import { runWeeklyAreaScopeTests } from "./weekly-area-scope.test.ts";
import { runSalesHeadOfficeLockTests } from "./sales-head-office-lock.test.ts";
import { runSqlExcludeCodesFailClosedTests } from "./sql-exclude-codes-fail-closed.test.ts";
import { runSosImportDashboardHeadOfficeLockTests } from "./sos-import-dashboard-head-office-lock.test.ts";
import { runAnalyticsViewerScopeTests } from "./analytics-viewer-scope.test.ts";
import { runRepAchievementPeriodsTests } from "./rep-achievement-periods.test.ts";
import { runAnalyticsClosingGeographyScopeTests } from "./analytics-closing-geography-scope.test.ts";
import { runAnalyticsFailureNotZeroTests } from "./analytics-failure-not-zero.test.ts";
import { runSupabasePaginationGuardsTests } from "./supabase-pagination-guards.test.ts";
import { runSosUiTruthTests } from "./sos-ui-truth.test.ts";
import { runSosDataCoverageTests } from "./sos-data-coverage.test.ts";
import { runSosRollupSqlTruthTests } from "./sos-rollup-sql-truth.test.ts";
import { runSosBackfillEmptyBrickSentinelTests } from "./sos-backfill-empty-brick-sentinel.test.ts";
import { runSosSeatAttributionPeriodTests } from "./sos-seat-attribution-period.test.ts";
import { runMonthlyClosingLockTests } from "./monthly-closing-lock.test.ts";
import { runClosingPeriodGateTests } from "./closing-period-gate.test.ts";
import { runDesignTokensContractTests } from "./design-tokens-contract.test.ts";
import { runNoEllipsisTruncationRatchetTests } from "./no-ellipsis-truncation-ratchet.test.ts";
import { runBadgeToneContrastTests } from "./badge-tone-contrast.test.ts";
import { runNavigationPageFindabilityRatchetTests } from "./navigation-page-findability-ratchet.test.ts";
import { runEmployeeTemplateTeamDropdownTests } from "./employee-template-team-dropdown.test.ts";
import { runSosMappingIntegrityTests } from "./sos-mapping-integrity.test.ts";
import { runSosIngestionNoSilentZeroTests } from "./sos-ingestion-no-silent-zero.test.ts";
import { runAnalyticsAreaScopeV2Tests } from "./analytics-area-scope-v2.test.ts";
import { runSosLatentGuardsTests } from "./sos-latent-guards.test.ts";
import { runSosDirectInAchievementTests } from "./sos-direct-in-achievement.test.ts";
import { runSosDirectToDmTests } from "./sos-direct-to-dm.test.ts";
import { runClosingMatrixTargetsTests } from "./closing-matrix-targets.test.ts";
import { runClosingFilteredExportKeepsDirectTests } from "./closing-filtered-export-keeps-direct.test.ts";
import { runDirectRegionAllocationTests } from "./direct-region-allocation.test.ts";
import { runDirectAmbiguousRegionBlockTests } from "./direct-ambiguous-region-block.test.ts";
import { runSosCodedPathCrossAreaGuardTests } from "./sos-coded-path-cross-area-guard.test.ts";
import { runSosWarehouseAreaDoesNotBlockBrickFillTests } from "./sos-warehouse-area-does-not-block-brick-fill.test.ts";
import { runSosIngestionRemainderTests } from "./sos-ingestion-remainder.test.ts";
import { runSalesScopeBlankRegionFailClosedTests } from "./sales-scope-blank-region-fail-closed.test.ts";
import { runSosUiTruthRemainderTests } from "./sos-ui-truth-remainder.test.ts";
import { runAnalyticsScopeWiringTests } from "./analytics-scope-wiring.test.ts";
import { runAnalyticsFilterContextualizationTests } from "./analytics-filter-contextualization.test.ts";
import { runAnalyticsRoutingTests } from "./analytics-routing.test.ts";
import { runAnalyticsMultiSelectTimeFiltersTests } from "./analytics-multi-select-time-filters.test.ts";
import { runSalesMarketingLineScopeTests } from "./sales-marketing-line-scope.test.ts";
import { runApprovalsHubCompletionTests } from "./approvals-hub-completion.test.ts";
import { runStaleDeployRecoveryTests } from "./stale-deploy-recovery.test.ts";
import { runPayrollCopilotTests } from "./payroll-copilot.test.ts";
import { runPayrollStatutoryTests } from "./payroll-statutory.test.ts";
import { runPayrollCopilotProrationTests } from "./payroll-copilot-proration.test.ts";
import { runPayrollCopilotDeductionsReviewTests } from "./payroll-copilot-deductions-review.test.ts";
import { runPayrollCopilotUnifiedDeductionsGuardTests } from "./payroll-copilot-refuses-unified-deductions.test.ts";
import { runPayrollInsuranceWageImportTests } from "./payroll-insurance-wage-import.test.ts";
import { runPayrollExportsTests } from "./payroll-exports.test.ts";
import { runPayrollCopilotReportExportsTests } from "./payroll-copilot-report-exports.test.ts";
import { runPayrollCopilotExpenseReviewTests } from "./payroll-copilot-expense-review.test.ts";
import { runPayrollCopilotHolidayBridgingTests } from "./payroll-copilot-holiday-bridging.test.ts";
import { runDirectOrdersApprovalFlowTests } from "./direct-orders-approval-flow.test.ts";
import { runDirectOrdersApprovalDetailNamesTests } from "./direct-orders-approval-detail-names.test.ts";
import { runDirectOrderFamilyBasketTests } from "./direct-orders-family-basket.test.ts";
import { runOutstationClaimsReadFlagTests } from "./outstation-claims-read-flag.test.ts";
import { runExpenseClaimsSelectRlsTests } from "./expense-claims-select-rls.test.ts";
import { runDirectOrdersUnbookedQueueTests } from "./direct-orders-unbooked-queue.test.ts";
import { runApiErrorsMustBeThrownTests } from "./api-errors-must-be-thrown.test.ts";
import { runDirectOrderReportColumnsTests } from "./direct-orders-report-columns.test.ts";
import { runMarketingRequestReportColumnsTests } from "./marketing-request-report-columns.test.ts";
import { runDirectOrderValidationCaptureReachableTests } from "./direct-orders-validation-capture-reachable.test.ts";
import { runDirectOrderSheetWebhookTests } from "./direct-orders-sheet-webhook.test.ts";
import { runDirectOrderReverseAuthorizationTests } from "./direct-orders-reverse-authorization.test.ts";
import { runDirectOrderErrorClassificationTests } from "./direct-orders-error-classification.test.ts";
import { runDirectOrderWorkspaceVocabularyTests } from "./direct-orders-workspace-vocabulary.test.ts";
import { runDirectOrderBadgeFastPathTests } from "./direct-orders-badge-fast-path.test.ts";
import { runDirectOrderPageAccessTests } from "./direct-orders-page-access.test.ts";
import { runDirectOrderRotationConfirmationTests } from "./direct-orders-rotation-confirmation.test.ts";
import { runDirectOrderRepCountersTests } from "./direct-orders-rep-counters.test.ts";
import { runDirectOrderCountersRefusedTests } from "./direct-orders-counters-refused.test.ts";
import { runDirectOrderFinanceMonthBadgeTests } from "./direct-orders-finance-month-badge.test.ts";
import { runDirectOrderCollectionTests } from "./direct-orders-collection.test.ts";
import { runDirectOrderRlsCoverageTests } from "./direct-orders-rls-coverage.test.ts";
import { runDirectOrderRegistryReplayTests } from "./direct-orders-registry-replay.test.ts";
import { runDirectOrderDeskShellTests } from "./direct-orders-desk-shell.test.ts";
import {
  runDirectOrderApprovalExceptionTests,
  runDirectOrderUnresolvedManagerRungTests,
} from "./direct-orders-unresolved-manager-rung.test.ts";
import { runDirectOrderOperationalQueryTests } from "./direct-orders-operational-query.test.ts";
import { runDirectOrderSecondReviewFixTests } from "./direct-orders-second-review-fixes.test.ts";
import { runFinanceManagerMonthlyClosingRowTests } from "./finance-manager-monthly-closing-row.test.ts";
import { runFinanceManagerCalendarRowTests } from "./finance-manager-calendar-row.test.ts";
import { runFinanceManagerArchivedRoiHiddenTests } from "./finance-manager-archived-roi-hidden.test.ts";
import { runDirectOrderEvidenceCheckTests } from "./direct-orders-evidence-check.test.ts";
import { runDirectOrdersApprovalWindowMobileTests } from "./direct-orders-approval-window-mobile.test.ts";
import { runEmployeePortalMobileInputZoomTests } from "./employee-portal-mobile-input-zoom.test.ts";
import { runEmployeePortalMobileTableCardTests } from "./employee-portal-mobile-table-cards.test.ts";
import { runCrmMobileTableCardTests } from "./crm-mobile-table-cards.test.ts";
import { runHrShellMobileTableTests } from "./hr-shell-mobile-tables.test.ts";
import { runOutstationMobileTableCardTests } from "./outstation-mobile-table-cards.test.ts";
import { runDoctorCoveragePaginationTests } from "./crm-doctor-coverage-pagination.test.ts";
import { runPharmacySearchTests } from "./pharmacy-search.test.ts";
import { runRscClientFunctionPropTests } from "./rsc-client-function-props.test.ts";
import { runDirectOrdersInvoiceScanTests } from "./direct-orders-invoice-scan.test.ts";
import { runDirectOrdersArabicSearchTests } from "./direct-orders-arabic-search.test.ts";
import { runCrmBrickCentroidsCacheTests } from "./crm-brick-centroids-cache.test.ts";
import { runDirectOrdersAreaAutofillTests } from "./direct-orders-area-autofill.test.ts";
import { runDirectOrdersExtraAreaGrantTests } from "./direct-orders-extra-area-grants.test.ts";
import { runDirectOrdersShareLinkControlsTests } from "./direct-orders-share-link-controls.test.ts";
import { runDirectOrderCancelHeldTests } from "./direct-orders-cancel-held.test.ts";
import { runDirectOrderInvoicePrefillTests } from "./direct-orders-invoice-prefill.test.ts";
import { runDirectOrderValidationRegistryGateTests } from "./direct-orders-validation-registry-gate.test.ts";
import { runDirectOrderPharmacyRejectedTests } from "./direct-orders-pharmacy-rejected.test.ts";
import { runDirectOrdersHeldLaneTests } from "./direct-orders-held-lane.test.ts";
import { runDirectOrdersPharmacyValidationTests } from "./direct-orders-pharmacy-validation.test.ts";
import { runPayrollResignationCandidateVisibilityTests } from "./payroll-resignation-candidate-visibility.test.ts";
import { runAnalyticsConfidentialProductCodeNormalizeTests } from "./analytics-confidential-product-code-normalize.test.ts";
import { runAnalyticsDimProductsHeadOfficeExclusionTests } from "./analytics-dim-products-head-office-exclusion.test.ts";
import { runMigrationsSecdefRevokeGuardTests } from "./migrations-secdef-revoke-guard.test.ts";
import { runAutomatedPayrollSplitTests } from "./automated-payroll-split.test.ts";
import { runAutomatedPayrollFingerprintAggregationTests } from "./automated-payroll-fingerprint-aggregation.test.ts";
import { runAutomatedPayrollExportOrderTests } from "./automated-payroll-export-order.test.ts";
import { runAutomatedPayrollPart1ScopeTests } from "./automated-payroll-part1-scope.test.ts";
import { runAutomatedPayrollNonEmployeesTests } from "./automated-payroll-non-employees.test.ts";
import { runAutomatedPayrollFabSheetTests } from "./automated-payroll-fab-sheet.test.ts";
import { runAutomatedPayrollNotifyGovernanceTests } from "./automated-payroll-notify-governance.test.ts";
import { runAutomatedPayrollNotifyPart1ReviewTests } from "./automated-payroll-notify-part1-review.test.ts";
import { runAutomatedPayrollUnconfirmPart1Tests } from "./automated-payroll-unconfirm-part1.test.ts";
import { runAutomatedPayrollResignationCrmTests } from "./automated-payroll-resignation-crm.test.ts";
import { runAutomatedPayrollCibSheetTests } from "./automated-payroll-cib-sheet.test.ts";
import { runAutomatedPayrollExecutiveSummaryTests } from "./automated-payroll-executive-summary.test.ts";
import { runAutomatedPayrollAssembleTests } from "./automated-payroll-assemble.test.ts";
import { runAutomatedPayrollPopulationDiffTests } from "./automated-payroll-population-diff.test.ts";
import { runAutomatedPayrollDataQualityTests } from "./automated-payroll-data-quality.test.ts";
import { runTerritoryRootScopeTests } from "./territory-root-scope.test.ts";
import { runTerritoryLineFilterTests } from "./territory-line-filter.test.ts";
import { runTerritoryReconciliationTests } from "./territory-reconciliation.test.ts";
import { runAuSeatOccupantResolverTests } from "./au-seat-occupant-resolver.test.ts";
import { runAuHireIntoSeatWiringTests } from "./au-hire-into-seat-wiring.test.ts";
import { runSalesImsRatioTests } from "./sales-ims-ratio.test.ts";
import { runHrIdCoreHelpersTests } from "./hrid-core-helpers.test.ts";
import { runMarketingRoiCohortsTests } from "./marketing-roi-cohorts.test.ts";
import { runGithubWorkflowValidityTests } from "./github-workflow-validity.test.ts";
import { runCiGateParityTests } from "./ci-gate-parity.test.ts";
import { runPasswordSetupEmailResolutionTests } from "./password-setup-email-resolution.test.ts";
import { runSchemaShapeCheckTests } from "./schema-shape-check.test.ts";
import { runSecretPinsCheckTests } from "./secret-pins-check.test.ts";
import { runSqlBackupPlacementTests } from "./sql-backup-placement.test.ts";
import { runAutomatedPayrollStepDetailTests } from "./automated-payroll-step-detail.test.ts";
import { runMigrationsCairoDateGuardTests } from "./migrations-cairo-date-guard.test.ts";
import { runAutomatedPayrollRejectedExpensesTests } from "./automated-payroll-rejected-expenses.test.ts";
import { runAutomatedPayrollExpenseResyncTests } from "./automated-payroll-expense-resync.test.ts";
import { runAutomatedPayrollReadsDeductionsModuleTests } from "./automated-payroll-reads-deductions-module.test.ts";
import { runAutomatedPayrollManualExpensesAndPart2NonEmployeesTests } from "./automated-payroll-manual-expenses-and-part2-non-employees.test.ts";
import { runFieldWorkforceThursdayHalfDayTests } from "./field-workforce-thursday-half-day.test.ts";
import { runDeductionsModuleNoRecordsScopeTests } from "./deductions-module-no-records-scope.test.ts";
import { runOutstationApprovedAmountTests } from "./outstation-approved-amount.test.ts";
import { runOutstationApprovalStateTests } from "./outstation-approval-state.test.ts";
import { runOutstationExpenseApprovalFiltersTests } from "./outstation-expense-approval-filters.test.ts";
import { runOutstationExpenseApprovalSummaryTests } from "./outstation-expense-approval-summary.test.ts";
import { runOutstationExpenseApprovalExportTests } from "./outstation-expense-approval-export.test.ts";
import { runOutstationExpenseApprovalDecisionsTests } from "./outstation-expense-approval-decisions.test.ts";
import { runApiSessionExpiredResponseTests } from "./api-session-expired-response.test.ts";
import { runOutstationWorkloadEvidenceTests } from "./outstation-workload-evidence.test.ts";

import { runCrmRepDayCheckinAttributionTests } from "./crm-rep-day-checkin-attribution.test.ts";

import { runAuthWebauthnTests } from "./auth-webauthn.test.ts";
import { runSfeDoctorCoverageTests } from "./sfe-doctor-coverage.test.ts";
import { runDoctorCoverageDistrictTests } from "./doctor-coverage-districts.test.ts";
import { runDoctorCoverageRepNameTests } from "./doctor-coverage-rep-names.test.ts";
// Registered beside its sibling rather than appended at the end of the file: every PR appends
// there, so a branch parked on that anchor conflicts with each one that lands (this PR hit it
// four times in one evening — #1910, #1918, #1919 and a re-run).
import { runDoctorCoverageScopeTests } from "./doctor-coverage-scope.test.ts";
import { runDoctorCoverageNormsTests } from "./doctor-coverage-norms.test.ts";
import { runVisitContactKindTests } from "./visit-contact-kind.test.ts";
import { runRootRedirectHttp307Tests } from "./root-redirect-http-307.test.ts";
import { runCrmUnmappedAgentAlertTests } from "./crm-unmapped-agent-alert.test.ts";
import { runCrmUnrecognizedVisitTypeAlertTests } from "./crm-unrecognized-visit-type-alert.test.ts";

import { runPayrollDeductionGateComposesWithPublishRuleTests } from "./payroll-deduction-gate-composes-with-publish-rule.test.ts";
import { runJuly2026DirectOrdersTabTests } from "./july-2026-direct-orders-tab.test.ts";
import { runJuly2026DirectValueIsStoredTests } from "./july-2026-direct-value-is-stored.test.ts";
import { runClosingHeadlineCountsDirectTests } from "./closing-headline-counts-direct.test.ts";

import { runAttendanceMonthlySummaryOutageTests } from "./attendance-monthly-summary-outage.test.ts";

import { runPayrollBatchMembershipTests } from "./payroll-batch-membership.test.ts";
import { runDeductionsEmployeeSummaryPublishEligibilityTests } from "./deductions-employee-summary-publish-eligibility.test.ts";
import { runDeductionsVacationDayDoubleChargeTests } from "./deductions-vacation-day-double-charge.test.ts";
import { runMarketingRoiSharedAttributionTests } from "./marketing-roi-shared-attribution.test.ts";
import { runCeoLandingSeatAndProbationCountsTests } from "./ceo-landing-seat-and-probation-counts.test.ts";
import { runSosTopCustomersAggregationTests } from "./sos-top-customers-aggregation.test.ts";
import { runCrmPortalCoveragePopulationsTests } from "./crm-portal-coverage-populations.test.ts";
import { runExportFollowsScreenFiltersTests } from "./export-follows-screen-filters.test.ts";
import { runNotificationDeliveryIntegrityTests } from "./notification-delivery-integrity.test.ts";
import { runOutstationExpenseApprovalStateMetricsTests } from "./outstation-expense-approval-state-metrics.test.ts";

import { runIncentiveSemesterWindowTests } from "./incentive-semester-window.test.ts";

import { runReconciliationHarnessTests } from "./reconciliation-harness.test.ts";
import { runOutstationSubmitEmailRoutingTests } from "./outstation-submit-email-routing.test.ts";
import { runOutstationExpenseGateTests } from "./outstation-expense-gate.test.ts";
import { runOutstationDepartureEvidenceTests } from "./outstation-departure-evidence.test.ts";
import { runEvidenceLocationStampTests, runEvidencePanelLayoutTests } from "./evidence-location-stamp.test.ts";
import { runOutstationWorkloadRollupTests } from "./outstation-workload-rollup.test.ts";
import { runOutstationDeparturePhotoReminderTests } from "./outstation-departure-photo-reminder.test.ts";
import { runOutstationDeparturePhotoResendTests } from "./outstation-departure-photo-resend.test.ts";
import { runOutstationWorkloadRepairTests } from "./outstation-workload-repair.test.ts";
import { runWorkflowRegistryRetargetGuardTests } from "./workflow-registry-retarget-guard.test.ts";



import { runSalesVsTargetTests } from "./sales-vs-target.test.ts";
import { runAchievementCountsUnmappedTests } from "./achievement-counts-unmapped.test.ts";
import { runAchievementHashableJoinKeyTests } from "./achievement-hashable-join-key.test.ts";
import { runDirectOrdersRegistryChainGrantsTests } from "./direct-orders-registry-chain-grants.test.ts";
import { runSalesCustomerChannelTests } from "./sales-customer-channel.test.ts";
import { runStoreSalesCitySplitTests } from "./store-sales-city-split.test.ts";
import { runClosingStoreSplitHonoursManualSplitTests } from "./closing-store-split-honours-manual-split.test.ts";
import { runClosingStoreSplitRiskFollowupsTests } from "./closing-store-split-risk-followups.test.ts";
import { runStoreSplitMatrixTests } from "./store-split-matrix.test.ts";
import { runStoreSplitDetailReportTests } from "./store-split-detail-report.test.ts";
import { runMonthlyClosingExportSplitStaticTests } from "./monthly-closing-export-split-static.test.ts";
import { runClosingExportMatchesScreenTests } from "./closing-export-matches-screen.test.ts";
import { runClosingPerformanceReviewTests } from "./closing-performance-review.test.ts";
import { runMonthlyClosingPeriodMergeTests } from "./monthly-closing-period-merge.test.ts";
import { runClosingReviewFilterTests } from "./closing-review-filters.test.ts";
import { runCeoMarketingApprovalInboxTests } from "./ceo-marketing-approval-inbox.test.ts";
import { runMarketingApprovalInboxNavBadgeTests } from "./marketing-approval-inbox-nav-badge.test.ts";

import { runMarketingApproverChainHistoryTests } from "./marketing-approver-chain-history.test.ts";

import { runMarketingApproverCustomerHistoryTests } from "./marketing-approver-customer-history.test.ts";
import { runMarketingSalesEvidenceAccessTests } from "./marketing-sales-evidence-access.test.ts";
// Registered beside its marketing siblings rather than appended at the end of the file: every PR
// appends there, so a branch parked on that anchor conflicts with each one that lands.
import { runMarketingCaseFileTests } from "./marketing-case-file.test.ts";
// Beside its marketing siblings, same reason as the anchor above: every PR appends at the file's
// end, so a branch parked there conflicts with each one that lands.
import { runMarketingCaseFileGoDeeperTests } from "./marketing-case-file-go-deeper.test.ts";
// Same anchor, same reason as the line above: beside its marketing siblings, not appended at the
// end of the file where every other in-flight branch is also adding a line.
import { runMarketingRejectedRequestVisibilityTests } from "./marketing-rejected-request-visibility.test.ts";
import { runMarketingRequestCaseFilePageTests } from "./marketing-request-case-file-page.test.ts";
import { runMarketingRequestEventsMigrationTests } from "./marketing-request-events-migration.test.ts";
import { runMarketingSelfApprovalTests } from "./marketing-self-approval.test.ts";
import { runMarketingRejectTerminalisesTests } from "./marketing-reject-terminalises.test.ts";
import { runMarketingRequestHistoryTests } from "./marketing-request-history.test.ts";
import { runMarketingProgressStripStatusTests } from "./marketing-progress-strip-status.test.ts";
import { runMarketingWorkQueuePageTests } from "./marketing-work-queue-page.test.ts";
import { runMarketingConfigGrantsTests } from "./marketing-config-grants.test.ts";
import { runSourceCoverageTests } from "./source-coverage.test.ts";
import { runOrganogramDualSeatVisibilityTests } from "./organogram-dual-seat-visibility.test.ts";
import { runSeatTransferServiceTests } from "./seat-transfer-service.test.ts";
import { runClosingChannelTabsTests } from "./closing-channel-tabs.test.ts";
import { runMonthlyClosingChannelsTests } from "./sales-monthly-closing-channels.test.ts";
import { runClosingChannelNothingDroppedTests } from "./closing-channel-nothing-dropped.test.ts";
import { runClosingChannelRollupEquivalenceTests } from "./closing-channel-rollup-equivalence.test.ts";
import { runClosingDistributorProductRollupEquivalenceTests } from "./closing-distributor-product-rollup-equivalence.test.ts";
import { runClosingChannelBreakdownRollupEquivalenceTests } from "./closing-channel-breakdown-rollup-equivalence.test.ts";
import { runMonthlyAttributionRollupEquivalenceTests } from "./monthly-attribution-rollup-equivalence.test.ts";
import { runClosingCorrectionsTests } from "./closing-corrections.test.ts";
import { runTerritoryScopeLineAwareTests } from "./territory-scope-line-aware.test.ts";
import { runTerritoryPreviewLinkControlsTests } from "./territory-preview-link-controls.test.ts";

import { runMonthlyClosingExportStoreSplitFilteredTests } from "./monthly-closing-export-store-split-filtered.test.ts";

import { runVacancySeatLinkageTests } from "./vacancy-seat-linkage.test.ts";
import { runClosingExcludesHeadOfficeTests } from "./closing-excludes-head-office.test.ts";
import { runClosingRegionGroupingPerLineTests } from "./closing-region-grouping-per-line.test.ts";
import { runPayrollFractionalDeductionDayScalingTests } from "./payroll-fractional-deduction-day-scaling.test.ts";
import { runDeductionsCrmSingleMonthScanTests } from "./deductions-crm-single-month-scan.test.ts";
import { runCrmDayMapPushdownTests } from "./crm-day-map-pushdown.test.ts";
import { runSfeManagerNavDeadLinksTests } from "./sfe-manager-nav-dead-links.test.ts";
import { runOrganogramNavLinkExistsTests } from "./organogram-nav-link-exists-for-every-role-that-can-open-it.test.ts";
import { runEveryOfferedLinkOpensTests } from "./every-offered-link-opens.test.ts";
import { runCrmHubCardReachabilityTests } from "./crm-hub-cards-are-reachable-by-the-roles-they-name.test.ts";
import { runCrmDepartedExclusionHandoverTests } from "./crm-departed-exclusion-handover.test.ts";
import { runOutstationArrivalPhotoCaptureReachableTests } from "./outstation-arrival-photo-capture-reachable.test.ts";
import { runOutstationAdminManualExpenseGateTests } from "./outstation-admin-manual-expense-gate.test.ts";
import { runOutstationDeparturePhotoRetakeTests } from "./outstation-departure-photo-retake.test.ts";
import { runOutstationAllowanceDuplicateDayGuardTests } from "./outstation-allowance-duplicate-day-guard.test.ts";
import { runOutstationCairoNoAllowanceTests } from "./outstation-cairo-no-allowance.test.ts";
import { runOutstationClaimValidationTests } from "./outstation-claim-validation.test.ts";
import { runOutstationEvidenceWaiverTests } from "./outstation-evidence-waiver.test.ts";
import { runOutstationNsmNoHoldTests } from "./outstation-nsm-no-hold.test.ts";
import { runOutstationExpenseNoteAssistTests } from "./outstation-expense-note-assist.test.ts";
import { runOutstationSubmissionWaitsForApprovalTests } from "./outstation-submission-waits-for-approval.test.ts";
import { runDirectOrdersPharmacyStandingTests } from "./direct-orders-pharmacy-standing.test.ts";

import { runDirectOrdersPharmacyComboboxPlacementTests } from "./direct-orders-pharmacy-combobox-placement.test.ts";
import { runDirectOrdersPharmacyCodeCollisionTests } from "./direct-orders-pharmacy-code-collision.test.ts";
import { runDirectOrdersBasketLabelTests } from "./direct-orders-basket-label.test.ts";

import { runDirectOrdersSheetEditableColumnsTests } from "./direct-orders-sheet-editable-columns.test.ts";

import { runSosSelfHealOwnerVerifiedGuardTests } from "./sos-self-heal-owner-verified-guard.test.ts";
import { runOutstationManualExpenseTicketPlusAllowanceTests } from "./outstation-manual-expense-ticket-plus-allowance.test.ts";
import { runClosingDirectAreaIdentityTests } from "./closing-direct-area-identity.test.ts";
import { runMonthlyClosingExportAreaMergeStaticTests } from "./monthly-closing-export-area-merge-static.test.ts";
import { runSalesStoreOverrideTests } from "./sales-store-override.test.ts";
import { runClosingExportFilenameTests } from "./closing-export-filename.test.ts";
import { runWeeklyPlansDistrictManagerBypassTests } from "./weekly-plans-district-manager-bypass.test.ts";
import { runNotificationRecipientAddressResolutionTests } from "./notification-recipient-address-resolution.test.ts";
import { runRecipientAssuranceGuardTests } from "./recipient-assurance-guard.test.ts";
import { runAutomatedPayrollExcludedMembersTests } from "./automated-payroll-excluded-members.test.ts";
import { runDirectOrderEvidenceVisibilityTests } from "./direct-orders-evidence-visibility.test.ts";
import { runDirectOrderHoldReleaseTests } from "./direct-orders-hold-release.test.ts";
import { runDirectOrderDuplicateCleanupTests } from "./direct-orders-duplicate-cleanup.test.ts";
import { runNsmCrmComplianceTests } from "./nsm-crm-compliance.test.ts";
import { runCrmCampaignAccountTests } from "./crm-campaign-account.test.ts";
import { runEarlyBirdsPeriodTests } from "./early-birds-period.test.ts";
import { runEarlyBirdsScoringTests } from "./early-birds-scoring.test.ts";
import { runEarlyBirdsDecisionTests } from "./early-birds-decisions.test.ts";
import { runEarlyBirdsScopeTests } from "./early-birds-scope.test.ts";
import { runEarlyBirdsLineStarsTests } from "./early-birds-line-stars.test.ts";
import { runCrmDepartedAgentScanTests } from "./crm-departed-agent-scan.test.ts";
import { runApiErrorInfrastructureRedactionTests } from "./api-error-infrastructure-redaction.test.ts";
import { runSchemaShapeDefaultAclTests } from "./schema-shape-default-acl.test.ts";
import { runSchemaShapePrivateUsageTests } from "./schema-shape-private-usage.test.ts";
import { runTerritorySyncTests } from "./territory-sync.test.ts";
import { runFinanceCommandCenterTests } from "./finance-command-center.test.ts";
import { runMarketingManagerMonthlyClosingTests } from "./marketing-manager-monthly-closing.test.ts";
import { runPortalHomePlanCountCanonicalTests } from "./portal-home-plan-count-canonical.test.ts";
import { runTelegramOnboardingCampaignCapTests } from "./telegram-onboarding-campaign-cap.test.ts";
import { runPublicSalesExposureGuardsTests } from "./public-sales-exposure-guards.test.ts";
import { runSosTeamPerformanceTests } from "./sos-team-performance.test.ts";
import { runEmployeeAchievementGroupingTests } from "./employee-achievement-grouping.test.ts";
import { runPortalCanonicalSalesRowsTests } from "./portal-canonical-sales-rows.test.ts";
import { runCanonicalDashboardRowsTests } from "./canonical-dashboard-rows.test.ts";
import { runEmployee360CanonicalSalesTests } from "./employee-360-canonical-sales.test.ts";
import { runNationalHolidaysObservanceFilterTests } from "./national-holidays-observance-filter.test.ts";
import { runDescribeThrownTests } from "./describe-thrown.test.ts";
import { runManagerCascadeFrozenTablesTests } from "./manager-cascade-frozen-tables.test.ts";
import { runSalesBatchDeleteGuardTests } from "./sales-batch-delete-guard.test.ts";
import { runReassignOwnershipFrozenWriteTests } from "./reassign-ownership-frozen-write.test.ts";
import { runAccessProfileSyncTests } from "./access-profile-sync.test.ts";
import { runMarketingPharmacyCodeCompactTests } from "./marketing-pharmacy-code-compact.test.ts";
import { runMasterMapMergeTests } from "./master-map-merge.test.ts";
import { runMasterMapOrganogramRegionsTests } from "./master-map-organogram-regions.test.ts";
import { runMasterMapDistrictManagersTests } from "./master-map-district-managers.test.ts";
import { runZoomablePhotoTests } from "./zoomable-photo.test.ts";
import { runMarketingCaseFileDecisionBarTests } from "./marketing-case-file-decision-bar.test.ts";
import { runMarketingDecisionPageReturnGatingTests } from "./marketing-decision-page-return-gating.test.ts";
import { runMarketingPharmacyCodeMatchTests } from "./marketing-pharmacy-code-match.test.ts";
import { runMarketingRequestStatusLabelTests } from "./marketing-request-status-label.test.ts";
import { runMarketingDecisionConfirmPromptTests } from "./marketing-decision-confirm-prompt.test.ts";
import { runMarketingDraftBlockersTests } from "./marketing-draft-blockers.test.ts";
// Registered beside its marketing siblings, not appended: this one pins the 2026-08-19 territory
// ruling, and a PR that touches marketing visibility must see it in the same block it edits.
import { runMarketingCustomerAreaOwnershipTests } from "./marketing-customer-area-ownership.test.ts";
// Registered next to the area-ownership test it reuses: that one pins who may SEE a customer, this
// one pins that the two write paths actually ask before raising a request against one.
import { runMarketingRequestCustomerScopeGuardTests } from "./marketing-request-customer-scope-guard.test.ts";
import { runMarketingSalesCodeSyncRerunTests } from "./marketing-sales-code-sync-rerun.test.ts";
import { runTerritoryAreaIndexTests } from "./territory-area-index.test.ts";

import { runCrmDayMapVisitTypeStatusTests } from "./crm-day-map-visit-type-status.test.ts";
import { runCrmBrickCoverageTests } from "./crm-brick-coverage.test.ts";

import { runRecruitmentCvReadHonestyTests } from "./recruitment-cv-read-honesty.test.ts";
import { runRecruitmentCvRereadTargetSetsTests } from "./recruitment-cv-reread-target-sets.test.ts";
import { runRecruitmentRereadModelConstantsTests } from "./recruitment-reread-model-constants.test.ts";
import { runRecruitmentExtractionRecordsIsCvTests } from "./recruitment-extraction-records-is-cv.test.ts";
import { runRecruitmentRereadNotACvSkipsTests } from "./recruitment-reread-not-a-cv-skips.test.ts";
import { runWorktreeExitGuardPreRemovalTests } from "./worktree-exit-guard-pre-removal.test.ts";
import { runMemoryIndexBudgetTests } from "./memory-index-budget.test.ts";
import { runSessionStartMemoryIndexGuardTests } from "./session-start-memory-index-guard.test.ts";
import { runRepoDoctorUnpushedCommitsTests } from "./repo-doctor-unpushed-commits.test.ts";

import { runCvRereadAppliesWhatItReadsTests } from "./cv-reread-applies-what-it-reads.test.ts";
import { runCandidateNameFromCvTests } from "./candidate-name-from-cv.test.ts";
import { runLegacyDocCvTests } from "./recruitment-legacy-doc-cv.test.ts";
import { runCvLibraryTests } from "./cv-library.test.ts";
import { runHiringEmployeeScopeTests } from "./hiring-employee-scope.test.ts";
import { runMarketingAdminOverrideNoteTests } from "./marketing-admin-override-note.test.ts";
import { runRecruitmentPoolFilterTests } from "./recruitment-pool-filters.test.ts";
import { runNotificationDrainHealthAlertTests } from "./notification-drain-health-alert.test.ts";
import { runNotificationOutboxBatchWindowTests } from "./notification-outbox-batch-window.test.ts";
import { runNotificationDrainStarvationGuardTests } from "./notification-drain-starvation-guard.test.ts";

const testDurationsMs: { name: string; durationMs: number }[] = [];

async function runTest(name: string, execute: () => void | Promise<void>) {
  const startedAt = performance.now();
  try {
    await execute();
    const durationMs = performance.now() - startedAt;
    testDurationsMs.push({ name, durationMs });
    console.log(`PASS ${name} (${durationMs.toFixed(0)}ms)`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runTest("transactional email survives an unsubscribe (password reset must never be withheld)", runTransactionalEmailNotUnsubscribableTests);
await runTest("i18n config", runI18nConfigTests);
await runTest("i18n Cairo date boundary (currentCairoDateOnlyIso EEST/EET rollover)", runI18nCairoDateBoundaryTests);
await runTest("portal target dedup (med-rep achievement sum-distinct, not max, not naive-sum)", runPortalTargetDedupTests);
await runTest("targets view scope (read-only DM/RM/NSM by AREA code, writes stay sales:import)", runTargetsViewScopeTests);
await runTest(
  "test wiring is complete (no test file imported-but-uninvoked, none orphaned)",
  runTestWiringCompleteTests,
);
await runTest("crm portal scope (exact-match agentHrIds, fail-closed, no ?view= governance panels)", runCrmPortalScopeTests);
await runTest("error monitor new-issue diff", runErrorMonitorNewIssueDiffTests);
await runTest("error monitor derived status", runErrorMonitorDerivedStatusTests);
await runTest("error monitor message decode", runErrorMonitorMessageDecodeTests);
await runTest("error monitor ai redact", runErrorMonitorAiRedactTests);
await runTest("error monitor per-user attempts (30d default window + real-account partition)", runErrorMonitorUserAttemptsTests);
await runTest("gcp-metrics service health reader (availability/latency/instances + {available:false} guard)", runGcpMetricsTests);
await runTest("weekly system health digest", runWeeklySystemHealthDigestTests);
await runTest("navigation active path", runNavigationActivePathTests);
await runTest("navigation ruling 11 (no analytics module in any role's rail, hub or command palette)", runNavigationRuling11AnalyticsTests);
await runTest("HR /hr URL namespace (authored nav, unforgeable shell header, narrowing-only)", runHrUrlNamespaceTests);
await runTest("every notification link points at a page that exists", runNotificationLinksResolveTests);
await runTest(
  "navigation personal layout (a layout rearranges the gated set and can never introduce an href)",
  runNavigationPersonalLayoutTests,
);
await runTest(
  "finance manager six-module access (sales scope + grant as one change, full closing workbook, organogram two-gate + head office, resignations read-only, line-scoped calendar, payslip document export)",
  runFinanceManagerSixModuleAccessTests,
);
await runTest("automated payroll pages render full width", runAutomatedPayrollPageWidthTests);
await runTest("sidebar width guard measures the font the app actually renders", runSidebarLabelFontSyncTests);
await runTest("sidebar labels never clip (no ellipsis, no wrap)", runSidebarLabelWidthTests);
await runTest("workspace pages render exactly one hero", runWorkspaceSingleHeroTests);
await runTest(
  "sidebar headings and hub rows are restored for Super Admin/CEO while the SFE Manager stays flat",
  runSidebarRoleScopedHeadingsTests,
);
await runTest(
  "source-of-sales product mapping checks (duplicate item codes + zero-sales gaps)",
  runSosProductMappingCheckTests,
);
await runTest("incentive scheme", runIncentiveSchemeTests);
await runTest("email notifications", runEmailNotificationTests);
await runTest("notification confidence gate (checks + decision logic)", runNotificationConfidenceGateTests);
await runTest("email governance", runEmailGovernanceTests);
await runTest("openai client", runOpenAiClientTests);
await runTest("email ai assist", runEmailAiAssistTests);
await runTest("sos ai-suggest retry/backoff", runSosAiSuggestRetryTests);
await runTest("employee import alert names its recipients (a subject-less ops alert resolves to nobody otherwise)", runEmployeeImportAlertRecipientTests);
await runTest("payroll workflow alert names its recipients (a subject-less ops alert resolves to nobody otherwise)", runPayrollWorkflowAlertRecipientTests);
await runTest("attendance ingestion alert never emails, and stays silent when disabled", runAttendanceAlertNoEmailTests);
await runTest("force logout HR_ID casing (app_sessions stores UPPER, activity_events stores lower)", runForceLogoutHrIdCasingTests);
await runTest("resignation notification subject (a leaver is still a valid SUBJECT, never a recipient)", runResignationNotificationSubjectTests);
await runTest("notification governance hardening", runNotificationGovernanceHardeningTests);
await runTest("birthday eligibility (on_leave included, terminal excluded, birth_date required)", runBirthdayEligibilityTests);
await runTest("unified notifications", runUnifiedNotificationsTests);
await runTest("notification step runner (per-step timeout budget + overlap guard)", runNotificationStepRunnerTests);
await runTest("payslip email block (payslips never emailed)", runPayslipEmailBlockTests);
await runTest("marketing SLA email block (SLA reminders never emailed)", runMarketingSlaEmailBlockTests);
await runTest("Early Birds email block (in-app + Telegram only)", runEarlyBirdsEmailBlockTests);
await runTest("recruitment attachment filename never becomes an envelope name", runRecruitmentAttachmentFilenameNameTests);
await runTest("recruitment CV-received notice never emails (in-app + Telegram only)", runRecruitmentCvNoEmailTests);
await runTest("candidate pushed to a hiring manager never emails (in-app + Telegram + push)", runCandidateAssignedEmailBlockTests);
await runTest("active roster only (resigned reps never reach a board)", runActiveRosterOnlyTests);
await runTest("telegram operations", runTelegramOperationsTests);
await runTest("telegram admin control center", runTelegramAdminControlCenterTests);
await runTest("email admin control center", runEmailAdminControlCenterTests);
await runTest("telegram template management", runTelegramTemplateManagementTests);
await runTest("telegram hardening", runTelegramHardeningTests);
await runTest("telegram permanent-delivery-error classification", runTelegramDeliveryErrorsTests);
await runTest("notification config drift guard", runConfigDriftTests);
await runTest("residence geocode policy (a failed geocode must never null a stored coordinate)", runResidenceGeocodePolicyTests);
await runTest("outstation fuel policy (an unmeasurable car distance must block, a measured 0 must not)", runOutstationFuelPolicyTests);
await runTest("dead-man's-switch (Healthchecks.io ping helper)", runDeadMansSwitchTests);
await runTest("direct orders sweeps stay watched (dead-man's-switch wiring)", runDirectOrdersSweepLivenessTests);
await runTest(
  "healthchecks schedule sync (docs/observability.md is the source of truth for every check)",
  runHealthchecksScheduleSyncTests,
);
await runTest("direct orders hr-id filters are case-insensitive", runDirectOrdersHrIdCaseTests);
await runTest(
  "synthetic journeys liveness (a refused dispatch must ping /fail, not a green check)",
  runSyntheticJourneysLivenessTests,
);
await runTest(
  "sheet token rotation liveness (a rotation that did not rotate must ping /fail)",
  runSheetTokenRotationLivenessTests,
);
await runTest(
  "db health snapshot liveness (the route swallows its own error, so the catch must ping /fail)",
  runDbHealthSnapshotLivenessTests,
);
await runTest("money path silent failures (a confident zero is worse than an error)", runMoneyPathSilentFailureTests);
await runTest("payroll sheet mapping", runPayrollSheetMappingTests);
await runTest("payroll workflow", runPayrollWorkflowTests);
await runTest("automated payroll split (Part 1/2 freeze + FP-in-Part-1 + reconcile)", runAutomatedPayrollSplitTests);
await runTest("automated payroll fingerprint aggregation (rejected candidates excluded)", runAutomatedPayrollFingerprintAggregationTests);
await runTest("automated payroll export order (fixed HR-ID sequence)", runAutomatedPayrollExportOrderTests);
await runTest("automated payroll Part 1/2 scope (no CRM/vacation double-deduction)", runAutomatedPayrollPart1ScopeTests);
await runTest("automated payroll Non-Employees Payroll (inline rows + accurate Executive Summary)", runAutomatedPayrollNonEmployeesTests);
await runTest("automated payroll FAB bank-transfer sheet (schema + filtering)", runAutomatedPayrollFabSheetTests);
await runTest("automated payroll notify governance (authorizedRecipient fix)", runAutomatedPayrollNotifyGovernanceTests);
await runTest("automated payroll notify Part 1 review email (To Adel+Ahmed, Cc Anwar)", runAutomatedPayrollNotifyPart1ReviewTests);
await runTest("automated payroll unconfirm Part 1 (phase guard, clear frozen values, audit)", runAutomatedPayrollUnconfirmPart1Tests);
await runTest("automated payroll Resignations CRM deduction (unified month-days rate)", runAutomatedPayrollResignationCrmTests);
await runTest("automated payroll CIB bank-transfer sheet (schema + filtering + styling)", runAutomatedPayrollCibSheetTests);
await runTest("automated payroll Executive Summary Dashboard (headcount + value vs last month)", runAutomatedPayrollExecutiveSummaryTests);
await runTest("automated payroll assembleRows + reconcile (each deduction counted exactly once)", runAutomatedPayrollAssembleTests);
await runTest("automated payroll population diff (silent-disappearance guard)", runAutomatedPayrollPopulationDiffTests);
await runTest("automated payroll data quality (a missing field must never become a default that pays money)", runAutomatedPayrollDataQualityTests);
await runTest("content security policy headers (wasm + maps + onesignal)", runCspHeaderTests);
await runTest("pdf canvas file-tracing (@napi-rs is hoisted AND the trace globs actually resolve it)", runPdfCanvasTraceTests);
await runTest("ready payroll proration (real month length, not a fixed 30)", runReadyPayrollProrationTests);
await runTest("ready payroll template formulas", runReadyPayrollTemplateFormulaTests);
await runTest("payroll engine hardening", runPayrollEngineHardeningTests);
await runTest("phoenix hr reply template", runPhoenixHrReplyTemplateTests);
await runTest("platform metrics", runPlatformMetricsTests);
await runTest("expense metrics", runExpenseMetricsTests);
await runTest("payroll money rounding", runPayrollMoneyTests);
await runTest("sales money rounding", runSalesMoneyRoundingTests);
await runTest("expense trip dedup", runExpenseTripDedupTests);
await runTest("outstation decision engine (distance + governorate + campaign + ticket)", runOutstationDecisionTests);
await runTest("outstation expense import trip_id (R1 content-hash fallback)", runOutstationExpenseImportTripIdTests);
await runTest("marketing bulk-import atomicity", runMarketingBulkImportAtomicityTests);
await runTest("sales bulk-import gating (idle/untouched never blocks Confirm & Import All)", runSalesBulkImportGatingTests);
await runTest("marketing access gates (bulk-upload preview/template + direct-tracking read)", runMarketingAccessGatesTests);
await runTest("validated customer register + Direct Order transfer gates", runValidatedCustomerTransferTests);
await runTest("area consolidation gates + table coverage", runAreaConsolidationTests);
await runTest("login bridge resync hardening", runLoginBridgeResyncHardeningTests);
await runTest("operational events", runOperationalEventsTests);
await runTest("recruitment onboarding metrics", runRecruitmentOnboardingMetricsTests);
await runTest("recruitment candidate matching", runRecruitmentCandidateMatchingTests);
await runTest("recruitment pipeline state machine", runRecruitmentPipelineStateMachineTests);
await runTest("recruitment readiness", runRecruitmentReadinessTests);
await runTest("recruitment cv extraction", runRecruitmentCvExtractionTests);
await runTest("probation provisioning", runProbationProvisioningTests);
await runTest("probation date (hire+90 canonical, edge cases)", runProbationDateTests);
await runTest("probation case provisioning (idempotent ensureCase + hire trigger + backfill dry-run)", runProbationCaseProvisioningTests);
await runTest("probation domain migration readiness (Phase 1 schema + Phase 2 trigger)", runProbationDomainMigrationReadinessTests);
await runTest("crm identity waterfall (override>crm_id>unique username, no-guess) + double-visit predicate", runCrmIdentityTests);
await runTest("crm post-exit attribution guard (work after an exit date is never filed under the leaver)", runCrmPostExitAttributionTests);
await runTest("crm pre-hire attribution guard (nobody is credited with work dated before they joined)", runCrmPreHireAttributionTests);
await runTest("crm pre-hire mapping guard (the Unmapped Agents screen refuses to create that miscredit)", runCrmPreHireMappingGuardTests);
await runTest("crm override employment scope (one mapping credits both holders of a handed-over slot)", runCrmOverrideEmploymentScopeTests);
await runTest("crm blocked-attribution counting (a holiday marker on a dead slot is not a handover)", runCrmBlockCountingTests);
await runTest("crm full-history parity sweep (windows, staleness, and the refuse-to-delete guard)", runCrmParitySweepTests);
await runTest("crm sync-run columns (every persisted column exists in the schema)", runCrmSyncRunColumnsTests);
await runTest("probation DV source definition (P3-T01 predicate + attribution + dedup key)", runProbationDvSourceTests);
await runTest("probation DV-Day detection (P3-T02 grouping + visit_count + unresolved surfacing)", runProbationDvDetectionTests);
await runTest("probation DV-Day validation (P3-T03/T04/T05/T06 dedup+identity+role+window)", runProbationDvValidationTests);
await runTest("probation DV persistence + review queue (P3-T07/T08 visit rows + ingest issues)", runProbationDvPersistenceTests);
await runTest("probation DV sync writer (P3-T09/T10 idempotent cohort-scoped capture + sync health)", runProbationDvSyncTests);
await runTest("probation feedback workflow (P4 scorecard + SLA + row-level auth + versioning)", runProbationFeedbackWorkflowTests);
await runTest("probation assessments (P5 SFE evidence + role auth + confidential + HR field-force enabled)", runProbationAssessmentsTests);
await runTest("probation scoring + contradictions (P6 DM-avg, weights, provisional/final, conflicts)", runProbationScoringTests);
await runTest("probation consolidated report (P7 milestones + progress + composition)", runProbationReportTests);
await runTest("probation CEO dashboard (P8 risk classification + exception flags + rollup)", runProbationDashboardTests);
await runTest("probation emails (P9 template registration + confirmed recipients + dedup)", runProbationEmailsTests);
await runTest("probation Cairo-today consistency (dashboard/report/emails share one Cairo-aware clock, not silent UTC default)", runProbationCairoTodayConsistencyTests);
await runTest("probation notification controls (MOD-3 daily cap + MOD-4 pre-send audit)", runProbationNotificationControlsTests);
await runTest("email render harness (functional contextVariables → interpolate + all-module token coverage)", runEmailRenderHarnessTests);
await runTest("token registry consistency (placeholderHints/variableCatalog/contextVariables/htmlBlockTokens all derive from TOKEN_REGISTRY)", runTokenRegistryConsistencyTests);
await runTest("probation decision (P10 authority + idempotent side effects + no-extend + lock)", runProbationDecisionTests);
await runTest("probation completion report (P11 acceptance-criteria matrix + migrations)", runProbationCompletionReportTests);
await runTest("probation enhancements prereq (PF-1 registry gates + PF-2 config select)", runProbationEnhancementsPrereqTests);
await runTest("probation development actions (E1 wire the stub)", runProbationDevActionsTests);
await runTest("probation config editor (E5 validation + save wiring)", runProbationConfigEditorTests);
await runTest("probation CRM-unmapped badge (E6 classifier + dashboard wiring)", runProbationCrmUnmappedTests);
await runTest("probation manager feedback inbox (E2 portal wiring)", runProbationFeedbackInboxTests);
await runTest("probation outcomes analytics (E4 rollups + predictiveness)", runProbationOutcomesAnalyticsTests);
await runTest("probation capture UIs (C1–C6 feedback/assessment/dev-action write forms)", runProbationCaptureUisTests);
await runTest("probation manual scorecards (open a DV-Day the CRM never produced)", runProbationManualScorecardTests);
await runTest("probation audit fixes (F1–F13 pre-merge hardening)", runProbationAuditFixesTests);
await runTest("probation audit fixes round 2 (R1–R10 deep hardening)", runProbationAuditFixesRound2Tests);
await runTest("probation legacy decision write-through to cases (dashboard/email desync fix)", runProbationLegacyWritesToCasesTests);
await runTest("recruitment scorecards", runRecruitmentScorecardsTests);
await runTest("recruitment drive storage", runRecruitmentDriveStorageTests);
await runTest("recruitment vacancy close invariant", runRecruitmentVacancyCloseInvariantTests);
await runTest("recruitment interview notifications", runRecruitmentInterviewNotificationsTests);
await runTest("recruitment NSM/RM/CEO scoping (interview type by role, hierarchy/line scope wiring)", runRecruitmentNsmRmCeoScopingTests);
await runTest("recruitment cv extraction fields", runRecruitmentCvExtractionFieldsTests);
await runTest(
  "recruitment cv extraction quality (thin-read scoring, best-of merge, hyperlink capture, high effort, escalation ladder, recorded intake failure)",
  runRecruitmentCvExtractionQualityTests,
);
await runTest(
  "recruitment RULE cv extraction (no-AI primary path: ligature/shredded repair, phone+email+LinkedIn patterns, section slicing, district-first governorate, work history, rule-vs-AI merge policy, escalation gate)",
  runRecruitmentRuleExtractionTests,
);
await runTest("recruitment cv auto-apply (high-confidence gap-fill rules; a CREATED candidate's blank phone is filled, a MATCHED one's never is)", runRecruitmentCvAutoApplyTests);
await runTest("recruitment contact review (the attended path for the email auto-apply refuses to write; not-a-CV proposes nothing, run-together values never reach a UNIQUE index)", runRecruitmentContactReviewTests);
await runTest("recruitment offers (an unapproved offer can never be sent — the workflow registry allows offer_initiated -> offer_sent, and this is what closes it)", runRecruitmentOffersTests);
await runTest("recruitment hire draft (the CV and the offer carried into HR's Add Employee form; no salary is ever derived here — that belongs to payroll/policy.ts)", runRecruitmentHireDraftTests);
await runTest("recruitment candidate merge (a merge fills blanks and never overwrites; it is refused outright when the database would reject it half-way)", runRecruitmentCandidateMergeTests);
await runTest("recruitment pipeline metrics (time to hire, stalled applications, offers out vs accepted — a finished application is never counted as stalled)", runRecruitmentPipelineMetricsTests);
await runTest(
  "recruitment push to the hiring manager (a deliberate button, a failure that reaches the caller, and a recorded send the pipeline reads back)",
  runRecruitmentHiringManagerPushTests,
);
await runTest(
  "recruitment simplify (a requisition with no seat behind it, a fixed status with a note, the 405 that killed every status write, and a pool that counts CVs)",
  runRecruitmentSimplifyTests,
);
await runTest(
  "recruitment requisition position catalogue (the full active catalogue is pickable; a seatless requisition carries a real position_id and borrows the position title, and still needs a hiring manager)",
  runRecruitmentRequisitionPositionCatalogueTests,
);
await runTest("recruitment non-recruitable positions (Ceo is excluded from the requisition Position dropdown, owner-curated display filter)", runRecruitmentNonRecruitablePositionsTests);
await runTest(
  "recruitment manager inbox (a manager sees and answers what was pushed to them, the nationality flag, the pharma-experience filter, and one daily CV digest instead of 628 alerts)",
  runRecruitmentManagerInboxTests,
);
await runTest(
  "CV intake 6-hour digest (sender grouping, CC chain by role, silent when empty, cron route and registry wiring)",
  runCvIntakeDigest6hTests,
);
await runTest(
  "recruitment candidate pool table (the intake envelope becomes a name, the action strip is one line, and duplicates show on the desktop row)",
  runRecruitmentCandidatePoolTableTests,
);
await runTest(
  "recruitment labels (a stored code never reaches a screen as one: no \"REQ FILLED\", no \"Hr Interview\", no \"Cv\")",
  runRecruitmentLabelTests,
);
await runTest(
  "hiring documents labels (the status filter reads \"Resigned\", not \"resigned\", and no document shows its UUID)",
  runHiringDocumentsLabelTests,
);
await runTest(
  "searchable select (no dropdown clips an option with an ellipsis, and no option wraps to two lines)",
  runSearchableSelectNoEllipsisTests,
);
await runTest(
  "recruitment \"Applying for\" (the evidence ladder that lifts the column from 15 answered rows to 394, on verbatim production strings)",
  runRecruitmentAppliedForTests,
);
await runTest(
  "recruitment manager grouping (CVs pile up under the seat they were SENT to, and b-10 is not a second manager from B-10)",
  runRecruitmentManagerGroupingTests,
);
await runTest(
  "recruitment candidate seen tracking (a CV read once is never offered as a stranger again, and the marker survives the case trap)",
  runRecruitmentCandidateSeenTests,
);
await runTest(
  "recruitment screening page (the queue has an address, in both shells, and the viewer never comes from the URL)",
  runRecruitmentScreeningPageTests,
);
await runTest(
  "recruitment position folders (a CV is sent FOR a vacancy, and a manager's inbox folds into one page per position)",
  runCandidatePositionFolderTests,
);
await runTest(
  "arabic place match (an English address naming an Arabic place: Box is not Bacos, George is not Girga)",
  runArabicPlaceMatchTests,
);
await runTest(
  "recruitment position suggestion (the seat a CV is proposed for, and the four ways a place name lied)",
  runCandidatePositionSuggestionTests,
);
await runTest(
  "vacancy manager escalation (when the seat's own manager post is vacant, climb to whoever is above it)",
  runVacancyManagerEscalationTests,
);
await runTest(
  "recruitment stale-send check (a slow manager is nudged; a manager who cannot answer strands the CV on day one)",
  runRecruitmentStaleSendCheckTests,
);
await runTest(
  "recruitment advertising channels (the code round-trips from apply link to intake, or every CV loses its source)",
  runRecruitmentJobPostChannelTests,
);
await runTest("recruitment hub -> ADMIN-shell coverage (HR Advisory reaches every hub tool; the seven portal mirrors are offered to nobody)", runRecruitmentHubPortalCoverageTests);
await runTest("recruitment portal \"View CV\" opens the viewer instead of downloading", runRecruitmentPortalCvViewTests);
await runTest("recruitment inbound cv intake", runRecruitmentInboundCvIntakeTests);
await runTest("recruitment intake finalize patch (a late throw must not erase the candidate it recorded)", runRecruitmentIntakeFinalizePatchTests);
await runTest("recruitment email intake", runRecruitmentEmailIntakeTests);
await runTest("recruitment candidate role and region filters", runCandidateRoleRegionTests);
await runTest(
  "recruitment candidate screening facts (a hedged CV read never outranks a recorded one, and the row and the filter resolve the same role family)",
  runCandidateScreeningFactsTests,
);
await runTest(
  "recruitment CV file choice (screening mode picks the newest renderable CV, and says so when there is none)",
  runCvFileChoiceTests,
);
await runTest(
  "recruitment screening order (the queue meets field-force candidates first; nothing is hidden or auto-rejected)",
  runRecruitmentScreeningOrderTests,
);
await runTest(
  "recruitment employer name (the Employer cell shows a company or nothing, never wreckage)",
  runRecruitmentEmployerNameTests,
);
await runTest("recruitment whatsapp intake", runRecruitmentWhatsAppIntakeTests);
await runTest("whatsapp self-classification menus and replies", runWhatsAppSelfClassificationTests);
  await runTest("whatsapp owner conversation mirror", runWhatsAppOwnerMirrorTests);
await runTest(
  "recruitment whatsapp coexistence history (the backlog Meta replays)",
  runWhatsAppCoexistenceHistoryTests,
);
await runTest("recruitment whatsapp intake health (Meta API probe + silence gate)", runRecruitmentWhatsAppHealthTests);
await runTest(
  "recruitment whatsapp webhook routing (deterministic delivery check)",
  runWhatsAppWebhookRoutingTests,
);
await runTest(
  "recruitment whatsapp public reach (did anyone actually get through)",
  runWhatsAppPublicReachTests,
);
await runTest("recruitment inbound intake queue (backoff, dead-letter, dedupe key)", runRecruitmentInboundQueueTests);
await runTest("recruitment inbound mastery (analytics, spike, fuzzy dedup, cv-link allowlist)", runRecruitmentInboundMasteryTests);
await runTest("recruitment candidate source context (email subject / whatsapp first messages)", runRecruitmentCandidateSourceContextTests);
await runTest("recruitment db batching (.in() id lists stay inside the request URL)", runRecruitmentDbBatchTests);
await runTest("attendance calendar source", runAttendanceCalendarSourceTests);
await runTest("employee status filter consolidation (5 hand-rolled terminal-status filters → shared constant)", runEmployeeStatusFilterConsolidationTests);
await runTest("attendance working days", runAttendanceWorkingDaysTests);
await runTest("attendance Cairo-midnight boundary (shared cairoMidnightUtcIso, EEST/EET + dropped-punch regression)", runAttendanceCairoMidnightBoundaryTests);
await runTest("attendance tracking eligibility (device mapping OR field title)", runAttendanceTrackingEligibilityTests);
await runTest("attendance manager view access (self + direct reports)", runAttendanceManagerViewAccessTests);
await runTest("attendance flexible-hours engine", runAttendanceFlexibleHoursTests);
await runTest("payroll copilot cycle window + week tiling", runPayrollCopilotCycleWindowTests);
await runTest(
  "payroll cycle window is role-aware (Head Office 24->23, field force 1->30/31)",
  runPayrollCycleWindowRoleAwareTests,
);
await runTest("attendance reconcile-day gating", runAttendanceReconcileDayTests);
await runTest("attendance employee day-by-day report (access/policy-range)", runAttendanceEmployeeDayReportTests);
await runTest("attendance device-outage fail-safe", runAttendanceDeviceOutageFailsafeTests);
await runTest("attendance skipped punches split unknown vs deliberately ignored", runAttendanceSkippedPunchClassificationTests);
await runTest("attendance bulk holiday calendar", runAttendanceHolidayOverridesTests);
await runTest("field workforce compliance", runFieldWorkforceComplianceTests);
await runTest("field workforce compliance eligibility", runFieldWorkforceComplianceEligibilityTests);
await runTest("field workforce compliance live snapshots", runFieldWorkforceComplianceLiveSnapshotsTests);
await runTest("field workforce compliance scorecards", runFieldWorkforceComplianceScorecardsTests);
await runTest("company vacation report (CRM signal classification)", runCompanyVacationReportTests);
await runTest("sfe manager vacation source report (read-only + Phoenix vs CRM)", runSfeVacationSourceReportTests);
await runTest("nsm team calendar (manager grouping)", runNsmTeamCalendarTests);
await runTest("company holidays", runCompanyHolidaysTests);
await runTest("deductions governance foundation", runDeductionsGovernanceFoundationTests);
await runTest("deductions governance service", runDeductionsGovernanceServiceTests);
await runTest("deductions governance fwc connector", runDeductionsGovernanceFwcConnectorTests);
await runTest(
  "deductions governance payroll import stays disabled (no second writer to salary_records)",
  runDeductionsGovernancePayrollImportDisabledTests,
);
await runTest("deductions governance completion", runDeductionsGovernanceCompletionTests);
await runTest("deductions module foundation (unified module — candidate key, calculations, conflicts, validation)", runDeductionsModuleFoundationTests);
await runTest("deductions module publish eligibility (mandatory-vs-approval-gated selection rule)", runDeductionsModulePublishTests);
await runTest("deductions module CRM guards (suspect-date sync-gap detection + exclusion)", runDeductionsModuleCrmGuardsTests);
await runTest("deductions module portal read path (dual-read-by-month merge + legacy shape mapping)", runDeductionsModulePortalTests);
await runTest("deductions module safety guards (the 9 PR-1 defects — including that each guard is WIRED IN)", runDeductionsModuleSafetyTests);
await runTest("deductions read gate (company-wide reads are admin-only; portal deductions are self-only for every role)", runDeductionsReadGateTests);
await runTest("deductions supersede carries the decision (identity survives a changed day set; a grown day set resets to Pending)", runDeductionsSupersedeCarriesDecisionTests);
await runTest(
  "deductions module applied days (per-day selection drives the quantity, the amount, publish, and the collision gate)",
  runDeductionsModuleAppliedDaysTests,
);
await runTest(
  "deductions holiday bridge (nearest WORKING day either side of a governmental holiday, never double-charged)",
  runDeductionsHolidayBridgeTests,
);
await runTest(
  "deductions current-month guard (an unfinished month is never collectable, on Cairo boundaries)",
  runDeductionsCurrentMonthGuardTests,
);
await runTest(
  "deductions leaver settlement (a finished employment settles mid-month; insert-only, never reconcile)",
  runDeductionsLeaverSettlementTests,
);
await runTest(
  "deductions DSM no-record (the narrow manager exception, and every guard that keeps a gap from becoming a wrong deduction)",
  runDeductionsDsmNoRecordTests,
);
await runTest(
  "deductions vacation ledger guard (the HR-request path must not re-charge a day a CRM-signal candidate already claims)",
  runDeductionsVacationLedgerGuardTests,
);
await runTest("weekly planning foundation", runWeeklyPlanningFoundationTests);
await runTest("weekly monthly plans v1", runWeeklyMonthlyPlansV1Tests);
await runTest("plan workweek + linkage (role-aware week, slots, new activity types)", runPlanWorkweekLinkageTests);
await runTest("weekly plans RPC contract", runWeeklyPlansRpcContractTests);
await runTest("weekly plans concurrency", runWeeklyPlansConcurrencyTests);
await runTest("weekly plans hardening", runWeeklyPlansHardeningTests);
await runTest("weekly plan calendar owner scope (title eligibility, cross-line/hierarchy visible)", runWeeklyPlanCalendarOwnerScopeTests);
await runTest("planning calendar XLSX export (SFE Manager/Super Admin gate, per-user summary + detail)", runPlanningCalendarExportTests);
await runTest("weekly plans permission scope", runWeeklyPlansPermissionScopeTests);
await runTest("weekly plan visibility (manager-chain + company-wide roles)", runWeeklyPlanVisibilityTests);
await runTest("weekly plans drift check", runWeeklyPlansDriftCheckTests);
await runTest("weekly plan manager gap listing (stuck-approval detection)", runWeeklyPlanManagerGapTests);
await runTest("weekly plan region canonicalisation and area options", runWeeklyPlanRegionAreasTests);
await runTest(
  "plan adherence score (a week with nothing verifiable in it scores null, never 0)",
  runPlanAdherenceTests,
);
await runTest("action center weekly plans (approver inbox)", runActionCenterWeeklyPlansTests);
await runTest("weekly plans round-3 features (bulk approve, export, autosave, timeline, notifications, a11y, virtualization)", runWeeklyPlansRound3FeaturesTests);
await runTest("double visit analytics", runDoubleVisitAnalyticsTests);
await runTest("double visit report export (filters, xlsx, pdf)", runDoubleVisitReportExportTests);
await runTest("dv planner weekly digest", runDvPlannerWeeklyDigestTests);
await runTest("dv planner date check (confirmed/not-recorded/future/outside-range + visitor names)", runDvPlannerDateCheckTests);
await runTest("visits report sync (dedup + null-guard + delete-reconciliation + attendance/crm_save_date)", runVisitsReportSyncTests);
await runTest("crm call rate (Sat-Wed denominator, AM 2 / PM 10 targets, campaign never lifts the verified rate)", runCrmCallRateTests);
await runTest("crm reps plans board (live-month cap, company rate over days x reps, rep filter leaves totals alone)", runCrmRepsPlansTests);
await runTest("crm rep visits drill-down (territory states, proof buckets, reconciles with the board rate)", runCrmRepVisitsTests);
await runTest(
  "crm region -> brick suggestion (Arabic name key + the reps' own area; Kit Kat, Beba, and the Dokki/Edku trap)",
  runCrmRegionBrickSuggestTests,
);
await runTest(
  "crm campaign note (doctor / speciality / clinic pulled apart; the hospital and the GB rows the owner named)",
  runCrmCampaignNoteTests,
);
await runTest(
  "crm campaign contact match (a campaign doctor already on the list stops being called a prospect)",
  runCrmCampaignContactMatchTests,
);
await runTest(
  "crm reps plans period (a week's rate divides by the week's working days, never the month's)",
  runCrmRepsPlansPeriodTests,
);
await runTest("crm checkin-match (agent+contact+day rule, crm_save_date tie-break)", runCrmCheckinMatchTests);
await runTest("crm checkin page boundary (.gte cursor + id de-dupe across duplicate check_date)", runCrmCheckinPageBoundaryTests);
await runTest("crm vacation duration (per-date collapse: AM+PM = 1 day, duplicated AM+AM = 0.5)", runCrmVacationDurationTests);
await runTest("crm integrity correlation (contact match, save-lag, speed feasibility)", runCrmIntegrityCorrelationTests);
await runTest("crm single-source door (no module outside src/lib/crm queries the mirror directly)", runCrmSingleSourceTests);
await runTest("crm sync identity preservation (a SILENT null never overwrites a resolved agent_hr_id; a BLOCKED null still does)", runCrmSyncIdentityPreservationTests);
await runTest("crm visit time (GPS check-in → save time → none; never visit_date_time)", runCrmVisitTimeTests);
await runTest("crm reads hr-id casing (door matches agent/double hr ids case-insensitively)", runCrmReadsHrIdCasingTests);
await runTest("crm visits self-scope (My Visits portal module: exact agent/double hrId scoping, no searchParams override)", runCrmVisitsSelfScopeTests);
await runTest("crm live-sync window (8:30 AM-12:01 PM Cairo boundary, inclusive both ends)", runCrmLiveSyncWindowTests);
await runTest(
  "crm live poller (stable fingerprint, delta vs memo, cadence tiers, upsert-filter seam, startup "
  + "guards, and the hourly rep-doctor-list sync which is ranked BELOW both visit jobs and never "
  + "runs overnight)",
  runCrmLivePollerTests,
);
await runTest("crm duplicate visit collapse (contact-keyed: one rep+contact+day = one stop; comment text never groups)", runCrmDuplicateVisitCollapseTests);
await runTest("crm master export streaming workbook (multi-page, uncapped, valid xlsx, error aborts)", runCrmMasterExportWorkbookTests);
await runTest("crm degradation policy (a failed read never manufactures a classification; filters cannot lie)", runCrmDegradationPolicyTests);
await runTest("crm coverage filters (region/line/area/rep cascade offers no dead end, hides no vacancy, leaks no code)", runCrmCoverageFilterTests);
await runTest(
  "crm check-in coordinate guard (an impossible GPS fix cannot stand as proof-of-presence; the Najaf "
  + "glitch is refused, every bound is load-bearing, and the vendor's constant-zero `attendance` "
  + "field stays out of the master export)",
  runCrmCheckinCoordGuardTests,
);
await runTest(
  "crm ampm normalization (the vendor's mis-cased half-day markers are folded to AM/PM so the "
  + "master filter and the half-day count both see them; blank means no marker; an unrecognized "
  + "marker is kept, never dropped)",
  runCrmAmpmNormalizationTests,
);
await runTest(
  "crm visit type labels (the seven codes iReports360 never documented stop reaching a human as "
  + "\"Unknown\"; the vendor's own description still wins; -7 and -30 route on the rep's comment; a "
  + "resolved label must never be written back to visit_type_description)",
  runCrmVisitTypeLabelTests,
);
await runTest(
  "crm rep doctor lists (a doctor on a rep's plan who was never visited must show up as missed — "
  + "the population every visit-history board is blind to; adherence counts doctors only, departed "
  + "agents leave both sides, an unknown specialty is named not folded, the drill-down cap can "
  + "never look like a complete list, a doctor REMOVED from a list in the CRM is removed here too "
  + "while an empty or truncated vendor answer never prunes, and the scheduled window can never "
  + "reach a closed month)",
  runCrmRepDoctorListsTests,
);
await runTest(
  "crm rep coverage & frequency trend (a rep with no plan in a month reads BLANK, never 0% — and "
  + "the like-for-like cohort holds flat across a departure that moves the company line 25 points, "
  + "so a change in WHO is measured can never be reported as a change in performance)",
  runCrmRepDoctorTrendTests,
);
await runTest("LocationIQ geocode confidence (reverse/forward scoring + LocationIQ-first/Google-fallback wiring)", runLocationIqGeocodeConfidenceTests);
await runTest("private calendar", runPrivateCalendarTests);
await runTest("weekly plan approver UI parity (no buttons the server rejects; comments gated on participation)", runWeeklyPlanApproverUiParityTests);
await runTest("weekly plan move to another period (HR re-dates a plan the employee filed on the wrong week)", runWeeklyPlanMovePeriodTests);
await runTest("termination truth (company exits are not announced as resignations; complete actually terminates)", runTerminationTruthTests);
await runTest("resignation completion vacancy (completing a resignation leaves exactly one open vacancy for the seat — never zero, never two)", runResignationCompletionVacancyTests);
await runTest("Cairo leave today (entitlements reference date + excuse month allowance)", runCairoLeaveTodayTests);
await runTest("Cairo period seeds (a working period must never come from the raw UTC clock)", runCairoPeriodSeedGuardTests);
await runTest("shared person identity (B-10 = PHX-1 = admin-HR, one primitive)", runIdentityAliasesTests);
await runTest("leave source of truth", runLeaveSourceOfTruthTests);
await runTest("lifecycle risk source", runLifecycleRiskSourceTests);
await runTest("login page hardening", runLoginPageHardeningTests);
await runTest("communication source of truth", runCommunicationSourceOfTruthTests);
await runTest("coaching scoring", runCoachingScoringTests);
await runTest("coaching analytics", runCoachingAnalyticsTests);
await runTest("coaching excel export", runCoachingExcelExportTests);
await runTest("coaching import", runCoachingImportTests);
await runTest("coaching access scope", runCoachingAccessScopeTests);
await runTest("coaching permissions", runCoachingPermissionTests);
await runTest("coaching in-app notifications", runCoachingInAppNotificationTests);
await runTest("coaching date-only formatting (off-by-one safe)", runCoachingDateFormattingTests);
await runTest("rls gap closure", runRlsGapClosureTests);
await runTest("sales others bucket", runSalesOthersBucketTests);
await runTest("sales role mapping", runSalesRoleMappingTests);
await runTest("sales period", runSalesPeriodTests);
await runTest("sales source of truth", runSalesSourceOfTruthTests);
await runTest("sos monthly-closing report check (fully-published period detection)", runSosMonthlyReportCheckTests);
await runTest("sales distributor import", runSalesDistributorImportTests);
await runTest("customer normalize + pharmacy chains", runCustomerNormalizeTests);
await runTest("pharmacy geo validate (distance tiers)", runPharmacyGeoValidateTests);
await runTest("customer cross-distributor propagation", runCustomerPropagationTests);
await runTest("sos auto-apply gate", runSosAutoApplyTests);
await runTest("customer location clusters", runCustomerClustersTests);
await runTest("weekly sales import", runWeeklySalesImportTests);
await runTest("weekly sales access", runWeeklySalesAccessTests);
await runTest("monthly closing region scope", runMonthlyClosingRegionScopeTests);
await runTest("monthly closing details", runMonthlyClosingDetailsTests);
await runTest("sales restricted products (LA003/LA004)", runSalesRestrictedProductsTests);
await runTest("au targets validation (map-or-reject + confidential guard)", runAuTargetsValidationTests);
await runTest("targets template round-trip (smart banner/dropdowns + legacy header)", runTargetsTemplateRoundtripTests);
await runTest("employee 360 expense-analysis role allowlist", runEmployee360ExpenseRoleTests);
await runTest("employee 360 visit classification (CRM Unknown-type labeling)", runEmployee360VisitClassificationTests);
await runTest("employee 360 double-visit count (canonical double_crm_id + type {0,-8}, no over-count)", runEmployee360DoubleVisitCountTests);
await runTest("employee 360 sales confidential-product masking", runEmployee360SalesMaskingTests);
await runTest("employee 360 role-category scoping (six tabs, others excluded)", runEmployee360RoleCategoryTests);
await runTest("employee 360 workweek + visit/checkin day-of-week separation", runEmployee360WorkweekTests);
await runTest("employee 360 viewer scope (self/team/hierarchy/line/reps/company)", runEmployee360AccessTests);
await runTest("employee 360 portal browse-all fallback + detail route", runEmployee360PortalBrowseTests);
await runTest("weekly column contract", runWeeklyColumnContractTests);
await runTest("sos customer-map brick fill", runSosCustomerMapBrickFillTests);
await runTest("sos customer key", runSosCustomerKeyTests);
await runTest("sos code canonical (leading-zero drift)", runSosCodeCanonicalTests);
await runTest("customer directory", runCustomerDirectoryTests);
await runTest("customer mapping", runCustomerMappingTests);
await runTest("monthly closing comparison", runMonthlyClosingComparisonTests);
await runTest("monthly closing export scope (filter reaches every sheet)", runMonthlyClosingExportScopeTests);
await runTest("portal closing line choice (a requested line is honoured or refused, never swapped)", runPortalClosingLineChoiceTests);
await runTest("closing organogram regions (areas follow the org chart, per line)", runClosingOrganogramRegionsTests);
await runTest("employee template Area->Team dropdown (builder and Excel resolve the same range)", runEmployeeTemplateTeamDropdownTests);
await runTest("direct channel", runDirectChannelTests);
await runTest("direct orders land on their own area", runDirectOrdersLandOnTheirOwnAreaTests);
await runTest("office pivot", runOfficePivotTests);
await runTest("office allocation", runOfficeAllocationTests);
await runTest("office golden rule LOCK (owner, 2026-08-11)", runOfficeGoldenRuleLockTests);
await runTest('closing "of which Office" (Office units told apart from distributor sell-out)', runClosingOfficeDifferentiationTests);
await runTest(
  'closing "of wh. Office" is CNS ONLY (owner, 2026-08-25: the column and the Office Allocation '
  + "sheet appear on CNS and nowhere else; every other line's Closing Matrix is identical with and "
  + "without an Office grid, because the grid is a lens and never a source)",
  runOfficeColumnIsCnsOnlyTests,
);
await runTest(
  "EZ even split (owner, 2026-08-26: EZ is credited evenly across the CNS reps active in Cairo and "
  + "Giza that month; a settled month never re-splits when a rep later resigns, and every area gets "
  + "its own landing brick so the locked Office rule cannot collapse them)",
  runSosEvenSplitEzTests,
);
await runTest("closing matrix fold (matrix derived from distributor_product, matrix RPC dropped)", runClosingMatrixFoldTests);
await runTest("master workbook keyset (single keyset pass, raw_row folded, no OFFSET rescan)", runMasterWorkbookKeysetTests);
await runTest(
  "sales vs target cache (freshness token in the key; rows gzipped under Next's 2MB data-cache limit)",
  runSalesVsTargetCacheTests,
);
await runTest("monthly sales run", runMonthlySalesRunTests);
await runTest("sos resolveBrick precedence (area must not beat customer brick)", runSosResolveBrickPrecedenceTests);
await runTest("sos brick coverage (real metric, recorded on the commit path)", runSosBrickCoverageTests);
await runTest("sos crosswalk pagination (keyset, never unordered offset)", runSosCrosswalkPaginationTests);
await runTest("sos customer_map keyset guard (every .range() read is ORDER BY-stable)", runSosCustomerMapKeysetTests);
await runTest("sos ambiguous alias (same name -> resolves to nothing)", runSosAmbiguousAliasTests);
await runTest("sos normalizer", runSosNormalizerTests);
await runTest("sales recognize (single recognizer)", runSalesRecognizeTests);
await runTest("sales distributor registry", runSalesDistributorRegistryTests);
await runTest("sales profiles invariants", runSalesProfilesTests);
await runTest("sales master-data pagination", runSalesMasterDataPaginationTests);
await runTest("sales master-data edit/delete (soft deactivate)", runSalesMasterDataEditDeleteTests);
await runTest("sales brick relocate (new id + deactivate old)", runSalesBrickRelocateTests);
await runTest("distributor profile store (editable merge + validation)", runDistributorProfileStoreTests);
await runTest("weekly column profile store (editable merge + validation)", runWeeklyColumnProfileStoreTests);
await runTest("weekly de-cumulation (cumulative → real per-week)", runWeeklyDecumulationTests);
await runTest("weekly batch scope (cycle-month fetch narrowing)", runWeeklyBatchScopeTests);
await runTest("weekly summarized report (manager attribution, YTD stock, low-sales)", runWeeklySummaryReportTests);
await runTest("weekly tracked-line scope (golden rule: CNS / Anti Infective / Pedia)", runWeeklyTrackedLinesScopeTests);
await runTest("weekly branch area split (owner rule: even across governorates then areas)", runWeeklyBranchAreaSplitTests);
await runTest("weekly branch name scope (a depot name names its territory)", runWeeklyBranchNameScopeTests);
await runTest("weekly branch attribution (the split moves money and never creates it)", runWeeklyBranchAttributionTests);
await runTest("weekly month vs target scoping (access bound, tab gate, region symmetry)", runWeeklyMonthTargetScopeTests);
await runTest("sales raw template", runSalesRawTemplateTests);
await runTest("sales mapping database paging", runSalesMappingDatabaseTests);
await runTest("sales upload reconciliation", runSalesUploadReconcileTests);
await runTest("sales upload strict validation", runSalesUploadValidationTests);
await runTest("sales upload verification step (never-stuck invariant)", runSalesUploadVerificationTests);
await runTest("sales AI header-mismatch explain (privacy + no-op)", runSalesAiExplainTests);
await runTest("sales linkage gate (one engine)", runSalesLinkageTests);
await runTest("sales channels by rep (stems derived, restricted fail-closed, unattributed kept)", runSalesChannelsByRepTests);
await runTest("sos normalizer persist shape", runSosNormalizerPersistShapeTests);
await runTest("sos import template", runSosImportTemplateTests);
await runTest("import preview diff", runImportPreviewTests);
await runTest("employee import never resurrects a deactivated team (insert-only org entities)", runEmployeeImportTeamResurrectionGuardTests);
await runTest("org title casing keeps acronyms (HR/QPPV/CEO/SFE/R&D) and round-trips to the same code", runOrgTitleCaseAcronymTests);
await runTest("imports line canonicalization (Anti Inf → Anti infective; no duplicate lines rows)", runImportsLineCanonicalizationTests);
await runTest("employee import warns when an Area carries no Team (warn, never block)", runImportTeamBlankWarningTests);
await runTest("detect distributor", runDetectDistributorTests);
await runTest("detect distributor header-row pick (EG-BR regression)", runDistributorDetectionHeaderRowTests);
await runTest("shared header normalization (Arabic + deep scan + all sheets)", runDistributorHeaderNormalizationTests);
await runTest("brick suggestions", runBrickSuggestionsTests);
await runTest("import coverage aggregation", runImportCoverageTests);
await runTest("sos header detection", runSosHeaderDetectionTests);
await runTest("sales strict header conformance + name-first product", runSalesStrictConformanceTests);
await runTest("sales ROI batch dedup (one validated batch per period)", runSalesRoiBatchDedupTests);
await runTest("sos atomic finalize (lock + supersede + refresh + reconcile, all-or-nothing)", runSosAtomicFinalizeTests);
await runTest("sos header aliases", runSosHeaderAliasesTests);
await runTest("sos guardrails", runSosGuardrailsTests);
await runTest("sos warning cleanup", runSosWarningCleanupTests);
await runTest("customer map import", runCustomerMapImportTests);
await runTest("customer directory rollup", runCustomerDirectoryRollupTests);
await runTest("marketing manager role", runMarketingManagerRoleTests);
await runTest("marketing pharmacy master resolution (write path + never-throws guard)", runMarketingMasterResolutionTests);
await runTest("marketing venue territory (head office adopts master area, rep never moved)", runMarketingVenueTerritoryTests);
await runTest("marketing reference importer", runMarketingReferenceImporterTests);
await runTest("marketing ROI", runMarketingRoiTests);
await runTest("marketing ROI sheet import (dry-run)", runMarketingRoiSheetImportTests);
await runTest("marketing ROI report scope + filter options", runMarketingRoiReportScopeTests);
await runTest("marketing ROI report helpers (date math + body parse)", runMarketingRoiReportHelpersTests);
await runTest("marketing ROI forecast-vs-actual labeling", runMarketingRoiLabelingTests);
await runTest("marketing ROI Tracker (composes the authoritative engine, adds no fifth)", runMarketingRoiTrackerTests);
await runTest("marketing submission capture gates (not_found pharmacy code refused at write time, the portal offers the written-reason override, one shared minimum length)", runMarketingSubmissionCaptureGateTests);

await runTest(
  "nursery venue type (the rule is one predicate, an unknown type falls back to pharmacy, a "
  + "pharmacy target is byte-identical to its old distributor code id, both write loops go through "
  + "venueCodeSlots so a codeless venue still gets its link row, capture refuses both wrong "
  + "combinations, the reference_status gate can actually fire, ROI lists an unattributable target "
  + "instead of dropping it, and the migration drops both NOT NULLs)",
  runNurseryVenueTypeTests,
);
await runTest(
  "venue type must be asked (an unanswered type reads as a pharmacy from the database but is "
  + "refused at capture, nothing is demanded of a venue nobody has named, all three screens refuse "
  + "in the same sentence, none of them pre-selects an answer, all three server create sites refuse "
  + "an unanswered type, and normalizeVenueType survives only on the read path)",
  runVenueTypeMustBeAskedTests,
);
await runTest(
  "venue validation rule (either route identifies a venue and the code wins when both exist, a "
  + "nursery can only ever pass by licence because a resolving code on one was invented, the capture "
  + "prompt asks for everything the desk will refuse, filing refuses a venue with no location, and "
  + "approving a new venue refuses without an identity route while reject stays open)",
  runVenueValidationRuleTests,
);
await runTest(
  "marketing venue merge (a colliding child is counted not thrown, one collision does not abort the rest, a real failure still surfaces, all four child tables move, the loser is deactivated, the mark is idempotent, the FK is SET NULL so deleting a survivor keeps its duplicates' record, and the backfill cannot fire on the wrong database)",
  runMarketingVenueMergeTests,
);
await runTest(
  "marketing venue merge route + admin action (the merge is reachable at all, the route delegates authorization instead of re-deciding it, it is registered as its own audited CSRF mutation rather than falling through the /api/marketing-requests/** blanket, the picker reads the venue table so an unlinked duplicate is still offerable, and the Customer Database gate still matches the service's)",
  runMarketingVenueMergeRouteTests,
);
await runTest("marketing request overlap detection (double-count guard)", runMarketingRequestOverlapTests);
await runTest("marketing validation draft recovery (stale evidence must never be restored)", runMarketingValidationDraftTests);
await runTest("marketing ROI live lifecycle stages (rejected never counts as committed)", runMarketingRoiLiveStagesTests);
await runTest("marketing ROI confidence score (measurement trust, not performance)", runMarketingRoiConfidenceTests);
await runTest("marketing ROI explain (diagnostic classifier + read-only guards)", runMarketingRoiExplainTests);
await runTest("marketing ROI business report (requester/customer + read-only guards)", runMarketingRoiBusinessReportTests);
await runTest("pharmacy master matching (Phase 1 candidate classifier + read-only guards)", runPharmacyMatchingTests);
await runTest("marketing ROI facets (smart cascading filters)", runMarketingRoiFacetsTests);
await runTest("marketing ROI export workbook (xlsx builds)", runMarketingRoiExportWorkbookTests);
await runTest("marketing coverage report access (role sets)", runMarketingCoverageReportAccessTests);
await runTest("marketing coverage report reachability (every viewer role has a working shell route)", runMarketingCoverageReportReachabilityTests);
await runTest("marketing coverage report scope (Finance/Financial Advisor scoped, unlike ROI Tracking)", runMarketingCoverageReportScopeTests);
await runTest("marketing coverage actuals reliability (fact-first gaps + scope-narrowing pre-filter)", runMarketingCoverageActualsReliabilityTests);
await runTest("marketing coverage report role parity (page-guard wiring source-guard)", runMarketingCoverageReportRoleParityTests);
await runTest("marketing coverage facets (area/requesterTier cascading filters)", runMarketingCoverageFacetsTests);
await runTest("marketing coverage pharmacy merge (zero-sales never omitted)", runMarketingCoveragePharmacyMergeTests);
await runTest("marketing coverage group sales detail by pharmacy (product+month drill-down)", runMarketingCoverageGroupSalesDetailTests);
await runTest("marketing coverage KPI extension (distinct pharmacy/customer counts)", runMarketingCoverageKpiExtensionTests);
await runTest("marketing coverage preset migration readiness (report_kind column)", runMarketingCoveragePresetMigrationReadinessTests);
await runTest("marketing coverage export workbook (xlsx builds)", runMarketingCoverageExportWorkbookTests);
await runTest("marketing coverage report analytics (rollup/trend/outlier)", runMarketingCoverageReportAnalyticsTests);
await runTest("marketing coverage distributor rollup (weighted cost/required-ROI split)", runMarketingCoverageDistributorRollupTests);
await runTest("marketing coverage URL filter state (shareable link round-trip)", runMarketingCoverageUrlStateTests);
await runTest("marketing ROI attribution consistency (no brick/geography fallback across all paths)", runMarketingRoiAttributionConsistencyTests);
await runTest("marketing ROI actuals toggle parity (includeRestricted must not silently drop direct-order sales)", runMarketingRoiActualsToggleParityTests);
await runTest("weekly sales BI export workbook (xlsx builds + clean)", runWeeklyExportTests);
await runTest("marketing request service", runMarketingRequestServiceTests);
await runTest("report rpc guardrails", runReportRpcGuardrailTests);
await runTest("marketing review routing", runMarketingReviewRoutingTests);
await runTest("marketing approver hr_id casing (FK fix)", runMarketingApproverHrIdCasingTests);
await runTest("marketing Super Admin oversight queue", runMarketingSuperAdminOversightTests);
await runTest("marketing approval inbox History tab (scope, read-only, stated cap)", runMarketingApprovalHistoryTabTests);
await runTest("marketing approval inbox decision bar (per-step reject/return powers)", runMarketingInboxDecisionBarGatingTests);
await runTest("marketing approval inbox workspace layout (queues, disclosure, desktop table)", runMarketingInboxWorkspaceLayoutTests);
await runTest("marketing premium notifications + review view", runMarketingPremiumNotificationTests);
await runTest("marketing request access", runMarketingRequestAccessTests);
await runTest("marketing validation service", runMarketingValidationServiceTests);
await runTest(
  "marketing validation: capturing a customer already on record completes it instead of duplicating it",
  runMarketingCompleteExistingCustomerTests,
);
await runTest(
  "marketing validation: capturing a shop already on record completes the evidence it never had",
  runMarketingCompleteExistingVenueTests,
);
await runTest("marketing governorate check", runMarketingGovernorateCheckTests);
await runTest(
  "marketing validation: the pharmacy card can shrink, so the tabs stay on screen on a phone",
  runMarketingValidationPharmacyCardMinWidthTests,
);
await runTest(
  "marketing evidence photo storage (the image is retained, not just its filename; a name with no image is refused)",
  runMarketingEvidencePhotoStorageTests,
);
await runTest(
  "pharmacy trade licence رخصة الصيدلية (owner, 2026-08-25: a licence can be attached beside a "
  + "validation so the trade name can be checked against the shop sign; it NEVER raises evidence "
  + "status, it lands in its own bucket so the JPEG-only wall on the two capture buckets stays up, "
  + "and both desks accept exactly the same files)",
  runPharmacyLicenseEvidenceTests,
);
await runTest(
  "marketing licence name check (the verdict lands on the pharmacy, not the request link row that a "
  + "resubmission deletes; only an explicit true/false is an answer; the author and the moment move "
  + "with it or the CHECK refuses; a pharmacy off the request is refused; and a mismatch flags "
  + "without ever rejecting the venue)",
  runMarketingPharmacyLicenseVerdictTests,
);
await runTest(
  "marketing field-capture backlog (the daily nudge reuses the badge's own rule so it can never chase a proven customer; one real visit clears every link; the rep who owns it is chased before their manager; a customer with neither is reported, not dropped; one rep is one bucket whatever the hr_id casing; a list holding both kinds is described as a split rather than claimed whole as his; and 51 recipients never means email)",
  runMarketingFieldCaptureBacklogTests,
);
await runTest("support requests notifications", runSupportRequestsNotificationsTests);
await runTest("organogram empty diagnostic", runOrganogramEmptyDiagnosticTests);
await runTest("position vacancy status integrity", runPositionVacancyStatusIntegrityTests);
await runTest("reconcile stale-replacement vacancy area + single-seat guard", runReconcileStaleVacancyAreaGuardTests);
await runTest("salary allowance policy", runSalaryAllowancePolicyTests);
await runTest("workforce classification", runWorkforceClassificationTests);
await runTest("workforce lifecycle seat", runWorkforceLifecycleSeatTests);
await runTest("HR_ID alias normalization (legacy AAA -> AA)", runHrIdAliasNormalizationTests);
await runTest("workforce hierarchy continuity", runWorkforceHierarchyContinuityTests);
await runTest("performance page reconciliation (header foots to leaderboard + unattributed slice)", runPerformanceReconciliationTests);
await runTest("payroll lifecycle scope", runPayrollLifecycleScopeTests);
await runTest("offer vacancy matching", runOfferVacancyMatchingTests);
await runTest("notification recipient isolation", runNotificationRecipientIsolationTests);
await runTest("workflow control center", runWorkflowControlTests);
await runTest("workflow control governance", runWorkflowControlGovernanceTests);
await runTest("workflow control migration readiness", runWorkflowControlMigrationReadinessTests);
await runTest("workflow control services", runWorkflowControlServicesTests);
await runTest("workflow control api routes", runWorkflowControlApiRoutesTests);
await runTest("outstation car evidence validation", runOutstationCarEvidenceValidationTests);
await runTest("outstation expense export", runOutstationExpenseExportTests);
await runTest("outstation local draft", runOutstationLocalDraftTests);
await runTest("outstation payroll expense mapping", runOutstationPayrollExpenseMappingTests);
await runTest("outstation import is additive and hr_id-scoped", runOutstationImportIsAdditiveTests);
await runTest("salary_records unique per employee per batch", runSalaryRecordsUniqueBatchHrTests);
await runTest("outstation policy classification", runOutstationPolicyClassificationTests);
await runTest("outstation notifications", runOutstationNotificationsTests);
await runTest("outstation employee-lookup status (isActive cosmetic field)", runOutstationEmployeeLookupStatusTests);
await runTest("medical rep expenses", runMedicalRepExpensesTests);
await runTest("employee portal sales scope", runEmployeePortalSalesScopeTests);
await runTest("employee portal navigation", runEmployeePortalNavigationTests);
await runTest("portal nav acting DM follows app access role, not job title", runPortalNavActingDmUsesAppRoleTests);
await runTest("employee portal bottom nav", runEmployeePortalBottomNavTests);
await runTest("employee portal nav catalog sync (M12)", runEmployeePortalNavCatalogSyncTests);
await runTest("company calendar", runCompanyCalendarTests);
await runTest("portal logging", runPortalLoggingTests);
await runTest("scope badge", runScopeBadgeTests);
await runTest("employee portal payslip salary", runEmployeePortalPayslipSalaryTests);
await runTest("admin payslip image export", runAdminPayslipImageExportTests);
await runTest("employee payroll eligibility", runEmployeePayrollEligibilityTests);
await runTest("employee access provisioning", runEmployeeAccessProvisioningTests);
await runTest("title permission governance", runTitlePermissionGovernanceTests);
await runTest(
  "HR function governance (a permission role is never a job title; the two retired HR seats fail "
  + "closed to Employee; no bundle OR individual function breaches a job-description boundary; the "
  + "matrix is composed from the catalogue rather than hand-edited; both seats keep a self-service floor)",
  runHrFunctionGovernanceTests,
);
await runTest(
  "HR seat route coherence (no HR seat holds PART of a route handler's permission set, so no page "
  + "its own sidebar offers can 403 it halfway)",
  runHrSeatRouteCoherenceTests,
);
await runTest(
  "HR command centre (every tile on a seat's landing dashboard links to a row that seat is "
  + "offered, so no figure leads to a page it cannot open)",
  runHrCommandCenterTests,
);
await runTest(
  "HR clearance & retention (both resources registered in the RUNTIME array as well as the union "
  + "- the sidebar lookup fails open on a key it has never seen - and the two seats' grants do "
  + "not cross: clearance is HR Operations', retention is HR Advisory's)",
  runHrClearanceRetentionTests,
);
await runTest("organogram hardening", runOrganogramHardeningTests);
await runTest("vacancy report / organogram consistency", runVacancyReportOrganogramConsistencyTests);
await runTest("organogram godmode", runOrganogramGodmodeTests);
await runTest("organogram head office branch (the AU seat model has no Head Office seats — the department was on nobody's chart)", runOrganogramHeadOfficeBranchTests);
await runTest(
  "organogram Head Office marketing chain + open seats (product managers sit on a sales line, so line_id alone left the whole marketing arm off every chart; an open Head Office seat could not be drawn at all)",
  runOrganogramHeadOfficeMarketingAndOpenSeatsTests,
);
await runTest("organogram line picker offers Head Office to viewers cleared for it (the portal picker dropped the branch after the permission gate had allowed it)", runOrganogramLinePickerHeadOfficeTests);
await runTest("organogram phantom seat suppression (stale-manager phantom DSM + same-area placeholder dup + NSM-direct vanish)", runOrganogramPhantomSeatSuppressionTests);
await runTest("vacancy report source", runVacancyReportSourceTests);
await runTest("organogram node-detail popup privacy boundary", runOrganogramNodeDetailPrivacyTests);
await runTest(
  "organogram audience picker (scoped filters cascade, ticks beat filters, emails dedupe, and the export sheet stays work-fields-only)",
  runOrganogramAudienceTests,
);
await runTest("probation stabilization", runProbationStabilizationTests);
await runTest("probation feedback security", runProbationFeedbackSecurityTests);
  await runTest("google routes fastest", runGoogleRoutesShortestTests);
await runTest("auth session", runAuthSessionTests);
await runTest("auth page access guard (guest-fallback predicate)", runAuthPageAccessTests);
await runTest("login page server-renders its form (no ssr:false, lazy webauthn)", runLoginPageServerRenderTests);
await runTest("auth audit hardening", runAuthAuditHardeningTests);
await runTest("employee display name", runEmployeeDisplayNameTests);
await runTest("employee import HR_ID alias resolution", runEmployeeImportHrIdAliasResolutionTests);
await runTest("employee import nickname guard (an import must never rename a person)", runEmployeeImportNicknameGuardTests);
await runTest("employee import seat validation", runEmployeeImportSeatValidationTests);
await runTest("employee import lifecycle (active payroll-ineligible execs not terminal; resigned stay protected)", runEmployeeImportLifecycleTests);
await runTest("employee region resolver (au line-area-region crosswalk derivation)", runEmployeeRegionResolverTests);
await runTest("employee record health", runEmployeeRecordHealthTests);
await runTest("employee salary details", runEmployeeSalaryDetailsTests);
await runTest("resignation date edit", runResignationDateEditTests);
await runTest("resignations dashboard scope (unscoped-read fix)", runResignationsDashboardScopeTests);
await runTest("resignations Cairo-today (exit-date defaults resolve via Africa/Cairo)", runResignationsCairoTodayTests);
await runTest("resignation submitted_by_hr_id FK (actor casing must not violate the employees FK; constraint errors are not 'schema missing')", runResignationSubmittedByFkTests);
await runTest("resignation CRM identity release (a leaver releases crm_id for their successor but KEEPS crm_username so their own trailing visits stay attributable)", runResignationCrmIdentityReleaseTests);
await runTest("probation feedback revival (coarse gate is probation:read, FK columns take the stored hr_id, both HR bundles resolve and are visible)", runProbationFeedbackRevivalTests);
await runTest("access profile hr_id casing (admin-typed hr_id is normalised before it reaches the employees FK)", runAccessProfileHrIdCasingTests);
await runTest("access governance hardening", runAccessGovernanceHardeningTests);
await runTest("RLS authenticated-read revoke (M3)", runRlsAuthenticatedReadRevokeTests);
await runTest("access registry coverage", runAccessRegistryCoverageTests);
await runTest("payroll mutation audit", runPayrollMutationAuditTests);
await runTest("vacation retention purge audit", runVacationRetentionPurgeAuditTests);
await runTest("access identity hardening", runAccessIdentityHardeningTests);
await runTest("cron control registry (job-registry <-> access-registry cross-reference)", runCronControlRegistryTests);
await runTest("cron control expression (validate/reject, next-run computation, collisions)", runCronControlExpressionTests);
await runTest("notification role recipients (default-policy drift guard)", runNotificationRoleRecipientsTests);
await runTest("email control center (aggregator module mapping + restored digests)", runEmailControlCenterTests);
await runTest("workflow registry", runWorkflowRegistryTests);
await runTest("workflow registry enforcement", runWorkflowRegistryEnforcementTests);
await runTest("approvals hub (vacation + excuse)", runApprovalsHubTests);
await runTest("notification auto-archive (bell)", runNotificationAutoArchiveTests);
await runTest("vacation approval flow", runVacationApprovalFlowTests);
await runTest("vacation calculations", runVacationCalculationTests);
await runTest("vacation module", runVacationModuleTests);
await runTest("vacation Cairo-today (balance-reference dates + Fri/Sat SLA weekday math)", runVacationCairoTodayTests);
await runTest("vacation paid approval atomic", runVacationPaidApprovalAtomicTests);
await runTest("vacation overlap warnings", runVacationOverlapWarningsTests);
await runTest(
  "vacation report filter equivalence (in-memory mirror of phx_vacation_report_rows: ILIKE case-insensitive/"
  + "anchored/wildcards, case-sensitive equality, concat_ws search incl id, date range, NULL-never-matches; "
  + "base-rows cache tag busted in the leave block; scope mirrors employee_hr_id = any(visible set))",
  runVacationReportFilterEquivalenceTests,
);
await runTest("csrf route coverage", runCsrfRouteCoverageTests);
await runTest("contract renewal hardening", runContractRenewalHardeningTests);
await runTest("contract non-renewal terminal lifecycle", runContractNonRenewalTerminalTests);
await runTest("contract non-renewal migration readiness", runContractNonRenewalMigrationReadinessTests);
await runTest("resignation employee scope check", runResignationScopeCheckTests);
await runTest("resignation workflow scope check", runResignationWorkflowScopeCheckTests);
await runTest("contract renewal workflow scope check", runContractRenewalWorkflowScopeCheckTests);
await runTest("customer pharmacy mapping readiness", runCustomerPharmacyMappingReadinessTests);
await runTest("customer pharmacy mapping actions (approve/reject)", runCustomerPharmacyMappingActionsTests);
await runTest("cv database", runCvDatabaseTests);
await runTest("transaction workflow audit", runTransactionWorkflowAuditTests);
await runTest("phase 13 browser smoke regressions", runPhase13BrowserSmokeRegressionTests);
await runTest("phase 14 controlled mutation smoke", runPhase14ControlledMutationSmokeTests);
await runTest("phase 15 disposable fixture smoke", runPhase15DisposableFixtureSmokeTests);
await runTest("phase 16 production gap burn-down", runPhase16ProductionGapBurndownTests);
await runTest("phase 17 workflow UI action closure", runPhase17WorkflowUiActionClosureTests);
await runTest("phase 18 fixture hygiene", runPhase18FixtureHygieneTests);
await runTest("phase 19 fixture cleanup", runPhase19FixtureCleanupTests);
await runTest("phase 20 production readiness", runPhase20ProductionReadinessTests);
await runTest("phase 21 security hardening", runPhase21SecurityHardeningTests);
await runTest("phase 22 role matrix security", runPhase22RoleMatrixSecurityTests);
await runTest("CEO organogram visibility", runCeoOrganogramVisibilityTests);
await runTest("Organogram WhatsApp number", runOrganogramWhatsAppNumberTests);
await runTest(
  "Organogram WhatsApp gate (line scope refuses an off-chart person with 404, the number never reaches the row or the browser, and it reaches the sheet only from the audited server route)",
  runOrganogramWhatsAppGateTests,
);
await runTest("CEO command center", runCeoCommandCenterTests);
await runTest("CEO account contract", runCeoAccountContractTests);
await runTest("phase 23 browser role walkthrough", runPhase23BrowserRoleWalkthroughTests);
await runTest("phase 24 real auth RLS/API smoke", runPhase24RealAuthRlsApiSmokeTests);
await runTest("phase 25 staging RLS mutation smoke", runPhase25StagingRlsMutationSmokeTests);
await runTest("phase 26 staging browser auth mutation smoke", runPhase26StagingBrowserAuthMutationSmokeTests);
await runTest("phase 27 staging app-service mutation smoke", runPhase27StagingAppServiceMutationSmokeTests);
await runTest("phase 28 production migration readiness", runPhase28ProductionMigrationReadinessTests);
await runTest("phase 29 production migration pre-apply review", runPhase29ProductionMigrationPreapplyReviewTests);
await runTest("phase 30 production migration approval gate", runPhase30ProductionMigrationApprovalGateTests);
await runTest("phase 32 production migration queue review", runPhase32ProductionMigrationQueueReviewTests);
await runTest("phase 33 migration history reconciliation gate", runPhase33MigrationHistoryReconciliationGateTests);
await runTest("staging executive dashboard migration reconciliation", runStagingExecutiveDashboardMigrationReconciliationTests);
await runTest("staging safe rebuild", runStagingSafeRebuildTests);
await runTest("email production readiness", runEmailProductionReadinessTests);
await runTest("email p0 testing trap", runEmailP0TestingTrapTests);
await runTest("email engine hardening", runEmailEngineHardeningTests);
await runTest("email send hardening", runEmailSendHardeningTests);
await runTest("admin telegram mirror (every email fires a Telegram twin of the always-BCC; never throws)", runAdminTelegramMirrorTests);
await runTest("email provider failover (Resend → Brevo, dedup-safe)", runEmailProviderFailoverTests);
await runTest("brevo webhook events (auth + event mapping + dedup)", runBrevoWebhookEventsTests);
await runTest("email activity (provider/recipient inference)", runEmailActivityTests);
await runTest("email templates triggers", runEmailTemplatesTriggersTests);
await runTest("email followups", runEmailFollowupsTests);
await runTest("report-it access", runReportItAccessTests);
await runTest("sos invoice date", runSosInvoiceDateTests);
await runTest("system cleanup center", runSystemCleanupCenterTests);
await runTest("excuses", runExcusesTests);
await runTest("excuse manager gap listing (stuck-approval detection + daily cron)", runExcuseManagerGapTests);
await runTest("expense access scope (PM/GPM/TM self+reports)", runExpenseAccessScopeTests);
await runTest("sales + payroll TEAM/HIERARCHY seat-continuity scope (resolver adoption)", runSalesPayrollHierarchyScopeTests);
await runTest("internal messages", runInternalMessagesTests);
await runTest("origin config single source", runOriginConfigSingleSourceTests);
await runTest("gcloud migration hardening", runGcloudMigrationHardeningTests);
await runTest("employee portal fingerprint visibility", runEmployeePortalFingerprintVisibilityTests);
await runTest("postgrest array filter guard", runPostgrestArrayFilterGuardTests);
await runTest("activity tracking", runActivityTrackingTests);
await runTest("activity manager view access (self + direct reports)", runActivityManagerViewAccessTests);
await runTest("attendance self-scope", runAttendanceSelfScopeTests);
await runTest("attendance exception notes (approving must not erase the requester's note)", runAttendanceExceptionNotesTests);
await runTest("hiring documents access (HR seat company-wide bypass)", runHiringDocumentsAccessTests);
await runTest("hiring document audit (every write names its actor, before-images read first)", runHiringDocumentsAuditTests);
await runTest("hiring document capture (polish keeps colour, pages become one A4 PDF, paths never collide)", runHiringDocumentCaptureTests);
await runTest("hiring document deadlines (a blur that changed nothing must not write, in both renders)", runHiringDocumentsDeadlineTests);
await runTest("hiring document status notes (an omitted notes key must not blank the cell)", runHiringDocumentsStatusNotesTests);
await runTest("hiring pack (Form 1 coordinate map, blank back page, تفقيط agreement)", runHiringPackTests);

await runTest(
  "offer letter (the pay formula against three signed offers plus a one-pound sweep, and both "
    + "renderers — print keeps raw HTML, email drops it and stays table-only for Outlook)",
  runOfferLetterPayAndRenderTests,
);
await runTest(
  "offer PDF runtime (the image's puppeteer pin matches package.json, and Chromium is found on "
    + "disk rather than assumed at the pre-Alpine-3.19 path)",
  runOfferPdfRuntimeTests,
);
await runTest(
  "offer built-in designs (both shipped letters use only block types the sanitizer keeps, so "
    + "neither loses a block on save; the executive skin is appended to one design and not the "
    + "other; and the running page foot is inline-styled, because Chromium renders footerTemplate "
    + "in a separate document where a var(--ink) prints nothing on every page)",
  runOfferBuiltinTemplateTests,
);
await runTest(
  "offer placeholders (the catalogue and the token builder list exactly the same set, so no token "
    + "is undiscoverable and no picker entry prints as literal braces; and the unknown-placeholder "
    + "walk reaches inside clause and benefit rows, where most of the letter's words live)",
  runOfferPlaceholderTests,
);
await runTest(
  "offer letter design per job title (the binding is matched the way the catalogue's unique index "
    + "matches, an unbound title answers null rather than the default so it cannot overwrite a "
    + "design somebody chose, and a binding to a deleted template resolves to null instead of a "
    + "dead id that renders the picker blank)",
  runOfferTitleTemplateTests,
);
await runTest(
  "offer letter dates (the picker's ISO and the letter's English survive a round trip on every "
    + "boundary date, a bare calendar date is never dragged across midnight by a timezone, and "
    + "'today' is answered in Cairo — where the company is — not in UTC)",
  runOfferDatesTests,
);
await runTest(
  "offer reference allocation (a generated reference never repeats one already on file, counts "
    + "past the highest rather than filling a withdrawn offer's gap, keeps each title and year on "
    + "its own run, and ignores anything typed in another shape)",
  runOfferReferenceTests,
);
await runTest(
  "offer draft warnings (a correctly filled offer raises nothing at all, each wrong pair of dates "
    + "produces exactly one note rather than several about the same pair, and a real address is "
    + "never rejected — being wrong that way costs a candidate their offer)",
  runOfferDraftCheckTests,
);
await runTest("sales null-vs-zero dashboard", runSalesNullVsZeroTests);
await runTest("sos analytics (MoM movers + pareto)", runSosAnalyticsTests);
await runTest("sos BI workbook export", runSosBiWorkbookTests);
await runTest("monthly sales dashboard workbook export", runMonthlyDashboardWorkbookTests);
await runTest("weekly-sales-pagination", runWeeklySalesPaginationTests);
await runTest("nav-badge store", runNavBadgeStoreTests);
await runTest("analytics validation helpers", runAnalyticsValidationTests);
await runTest("analytics metabase embed signer", runAnalyticsMetabaseEmbedTests);
await runTest("analytics filter independence (no cross-dimension leakage)", runAnalyticsFilterIndependenceTests);
await runTest("portal source-of-sales scope + smart filters", runPortalSosScopeTests);
await runTest("DM/RM seat-derived area scope (out-of-region areas)", runDmSeatAreaScopeTests);
await runTest("weekly sales optional area scope (branch-mapped areas)", runWeeklyAreaScopeTests);
await runTest("sales Head Office confidential lock (all surfaces)", runSalesHeadOfficeLockTests);
await runTest("SQL p_exclude_codes defaults are fail-closed (and match RESTRICTED_PRODUCT_CODES)", runSqlExcludeCodesFailClosedTests);
await runTest("SoS import dashboard Head Office line lock (loader + all callers)", runSosImportDashboardHeadOfficeLockTests);
await runTest("analytics per-viewer scope (line/region/product, per role)", runAnalyticsViewerScopeTests);
await runTest("rep achievement period resolution", runRepAchievementPeriodsTests);
await runTest("monthly closing geography scope (DM/RM area bound reaches the loader)", runAnalyticsClosingGeographyScopeTests);
await runTest("analytics failure is never rendered as a zero", runAnalyticsFailureNotZeroTests);
await runTest("supabase pagination guards (no unordered pages, no row ceilings, no swallowed page errors)", runSupabasePaginationGuardsTests);
await runTest("SoS UI truth (brick coverage denominator, export matches the screen)", runSosUiTruthTests);
await runTest("SoS data coverage (missing months + per-distributor gaps are visible)", runSosDataCoverageTests);
await runTest("SoS rollup SQL truth (Direct priced as Direct, backfill refreshes the rollup)", runSosRollupSqlTruthTests);
await runTest("SoS backfill matches the empty-string brick sentinel, not just NULL", runSosBackfillEmptyBrickSentinelTests);
await runTest("SoS seat attribution (today's wiring, departed reps keep their credit)", runSosSeatAttributionPeriodTests);
await runTest('Monthly closing lock (database triggers, not a disabled button)', runMonthlyClosingLockTests);
await runTest('CLOSING GOLDEN RULE (a month is never published during that month, Cairo boundary)', runClosingPeriodGateTests);
await runTest('design tokens contract (--phx- prefix, no globals.css collision, full dark coverage)', runDesignTokensContractTests);
await runTest('no-ellipsis ratchet (UI truncation sites may fall, never rise)', runNoEllipsisTruncationRatchetTests);
await runTest('Badge tone contrast (every tone meets WCAG AA for small text, both themes)', runBadgeToneContrastTests);
await runTest('Navigation findability ratchet (a page with no link anywhere may fall, never rise)', runNavigationPageFindabilityRatchetTests);
await runTest('SoS mapping integrity (alias edit replaces, exact customer key detects conflicts)', runSosMappingIntegrityTests);
await runTest('SoS ingestion (an unreadable cell is rejected, never silently zeroed)', runSosIngestionNoSilentZeroTests);
await runTest('analytics area scope v2 (reconciliation refuses area-scoped viewers, one active alias target)', runAnalyticsAreaScopeV2Tests);
await runTest('SoS latent guards + decisions of record', runSosLatentGuardsTests);
await runTest('SoS Direct counts toward achievement (targets were set including it)', runSosDirectInAchievementTests);
await runTest('SoS Direct reaches its region DM (not a rep), and UE-1/UE-2 exist to tag', runSosDirectToDmTests);
await runTest('Closing Matrix target columns (missing target is "—", never a 0 that fakes achievement)', runClosingMatrixTargetsTests);
await runTest('Direct region allocation (shares normalise to 1; a no-op where unconfigured)', runDirectRegionAllocationTests);
await runTest('Direct ambiguous region blocks at upload (Anti Infective only; CNS/Pedia keep "UE")', runDirectAmbiguousRegionBlockTests);
await runTest('SoS coded-path cross-area guard (blank-brick auto-fill never crosses the typed area)', runSosCodedPathCrossAreaGuardTests);
await runTest('SoS warehouse area (Main Store) never blocks a known brick from filling', runSosWarehouseAreaDoesNotBlockBrickFillTests);
await runTest('SoS ingestion remainder (Direct value, blank-customer info, office bad units)', runSosIngestionRemainderTests);
await runTest('sales scope fails closed on a blank region with no seat areas', runSalesScopeBlankRegionFailClosedTests);
await runTest('SoS UI truth remainder (headline vs breakdowns, territory target dedup, filtered footer)', runSosUiTruthRemainderTests);
await runTest("analytics scope wiring (every dashboard page scopes + fails closed)", runAnalyticsScopeWiringTests);
await runTest("analytics filter contextualization (trim dropdowns + hide single-value pickers)", runAnalyticsFilterContextualizationTests);
await runTest("analytics dual-mode routing (pages moved, bounce removed, permission + shell intact)", runAnalyticsRoutingTests);
await runTest("analytics multi-select time filters (period/channel/week/year)", runAnalyticsMultiSelectTimeFiltersTests);
await runTest("sales-marketing ROI line scope (product/region/distributor leak lock)", runSalesMarketingLineScopeTests);
await runTest("approvals hub completion (deep-link render + canonical actor + history scope)", runApprovalsHubCompletionTests);
await runTest("stale-deploy chunk-error recovery", runStaleDeployRecoveryTests);
await runTest("payroll copilot (assemble + flags + validator + parser)", runPayrollCopilotTests);
await runTest("payroll statutory (Egypt tax + social insurance)", runPayrollStatutoryTests);
await runTest("payroll copilot proration (resignation/joiner/unpaid-leave day-rate rules)", runPayrollCopilotProrationTests);
await runTest("payroll copilot deductions review (cycle window + month-key resolution)", runPayrollCopilotDeductionsReviewTests);
await runTest("payroll copilot refuses a sheet while the unified Deductions module owns the month (and Automated Payroll stays ungated)", runPayrollCopilotUnifiedDeductionsGuardTests);
await runTest("payroll insurance-wage import (parser)", runPayrollInsuranceWageImportTests);
await runTest("payroll exports (bank file + statutory summary)", runPayrollExportsTests);
await runTest("payroll copilot report exports (deduction/vacation/expense xlsx)", runPayrollCopilotReportExportsTests);
await runTest("payroll copilot expense review (month-lag: pays prior month's outstation)", runPayrollCopilotExpenseReviewTests);
await runTest("payroll copilot holiday bridging (mandatory before/after national-holiday deduction)", runPayrollCopilotHolidayBridgingTests);
await runTest("payroll resignation-candidate visibility (additive batch-dashboard banner; stripping untouched)", runPayrollResignationCandidateVisibilityTests);
await runTest("direct orders approval flow (ladder per role, sequential gating, caps flag not block, pharmacy-price value)", runDirectOrdersApprovalFlowTests);
await runTest("direct orders approval detail (names never codes, medical rep, notification completeness)", runDirectOrdersApprovalDetailNamesTests);
await runTest("direct orders family basket (Lacto only, confidential excluded, form offers what the service accepts)", runDirectOrderFamilyBasketTests);
await runTest("outstation claims-read flag (off by default, and the flag gates the import)", runOutstationClaimsReadFlagTests);
await runTest("expense_claims select RLS (select-only, grant after policy, no predicate widening)", runExpenseClaimsSelectRlsTests);
await runTest("direct orders unbooked queue (badge wired through all 4 lists, setter-only, filter, graduated ageing, dead tiles gone)", runDirectOrdersUnbookedQueueTests);
await runTest("api-errors factories are always thrown, never called bare (a dropped error is a guard that does nothing)", runApiErrorsMustBeThrownTests);
await runTest("direct orders report columns (positional twins, Arabic intact, nulls blank, NaN-safe totals)", runDirectOrderReportColumnsTests);
await runTest("marketing request report columns (positional twins, owner's 16 headers first, Sunday-week W2 rule, Cairo times)", runMarketingRequestReportColumnsTests);
await runTest("direct orders validation capture is reachable from BOTH the admin and portal routes (requester-only, held-only)", runDirectOrderValidationCaptureReachableTests);
await runTest("direct orders live-sheet webhook (void not awaitable, secret in body, all six transitions, script fails closed)", runDirectOrderSheetWebhookTests);
await runTest("direct orders reverse authorization (scope guard inherited, registry-gated, real status passed)", runDirectOrderReverseAuthorizationTests);
await runTest("direct orders error classification (every bare refusal reaches the caller as the right status, not 500)", runDirectOrderErrorClassificationTests);
await runTest("direct orders workspace vocabulary (no database status reaches a user; the inbox never shows a queue nobody can clear)", runDirectOrderWorkspaceVocabularyTests);
await runTest("direct orders badge fast path (cheap on a 30s poll, and shares the workspace's eligibility rule instead of copying it)", runDirectOrderBadgeFastPathTests);
await runTest("direct orders page access (all 8 pages in both shells refuse through one shared gate, before any data loads)", runDirectOrderPageAccessTests);
await runTest("direct orders rotation confirmation (evidence of use, never the reply body; unproven revokes nothing)", runDirectOrderRotationConfirmationTests);
await runTest("direct orders per-rep counters (scope borrowed not re-implemented, read-only, money-first sort, empty speaks)", runDirectOrderRepCountersTests);
await runTest("direct orders counters survive cleanup (a refusal on a REJECTED pharmacy counts, an ordinary rejection never does, the page does not go blank)", runDirectOrderCountersRefusedTests);
await runTest("direct orders finance-month badge (approved never shows alone, one shared pill not four, the gate gets the row not a constant)", runDirectOrderFinanceMonthBadgeTests);
await runTest("direct orders collection (identity gate not role gate, remainder derived, approved-only, and recording cash never moves the sales month)", runDirectOrderCollectionTests);
await runTest("direct orders RLS coverage (every direct_order_* table has RLS; a public table without it is reachable with the anon key)", runDirectOrderRlsCoverageTests);
await runTest("direct orders unresolved manager rung (a directory gap makes a rung that says it is broken, not one that looks healthy and blocks forever)", runDirectOrderUnresolvedManagerRungTests);
await runTest("direct orders approval exceptions (a stuck rung can be re-addressed, a healthy one cannot — the difference between a repair and an override)", runDirectOrderApprovalExceptionTests);
await runTest("direct orders registry replay (the migration chain must be replayable from scratch: no action may reference a status not yet declared)", runDirectOrderRegistryReplayTests);
await runTest("direct orders desk shell (every desk is framed by the workspace tab strip, and the strip has one definition)", runDirectOrderDeskShellTests);
await runTest("direct orders operational query (scope is a WHERE clause applied before pagination and before the count; every tier fails closed)", runDirectOrderOperationalQueryTests);
await runTest("direct orders second-review fixes (returned orders correct in place keeping their chain, no phantom draft queue, sales month approved-only server-side, Finance authority in one module)", runDirectOrderSecondReviewFixTests);
await runTest("finance manager monthly closing row (export-only surface not the upload workspace, both gates, no sales:import, full-sheet branch intact)", runFinanceManagerMonthlyClosingRowTests);
await runTest("finance manager calendar row (authoring page off the sidebar, planning calendar on it, and BOTH gates of the destination pinned)", runFinanceManagerCalendarRowTests);
await runTest("finance manager archived ROI hidden (removing the role is the fix; hiding the hub never was, because Cmd+K re-admits by role)", runFinanceManagerArchivedRoiHiddenTests);
await runTest("direct orders storefront evidence (unknown is never a pass, a failed read never blocks filing, and it never gates the decision)", runDirectOrderEvidenceCheckTests);
await runTest("direct orders cancel held (requester-or-Super-Admin, held-only, real status to the gate, cancelled is not rejected, every status has a chip and a colour)", runDirectOrderCancelHeldTests);
await runTest("direct orders approval window on mobile (every table desktop-only, every table has cards, no min-width reachable at 375px, totals and the not-final flag survive)", runDirectOrdersApprovalWindowMobileTests);
await runTest("employee portal mobile input zoom (16px floor on every portal input/select/textarea under 768px, max() not a flat size, the shell class still exists, pinch-zoom never disabled)", runEmployeePortalMobileInputZoomTests);
await runTest("employee portal mobile table cards (every converted table is desktop-gated with cards beside it, one shared SourceBreakdown, no <table> nested inside PortalDesktopTable)", runEmployeePortalMobileTableCardTests);
await runTest("CRM mobile table cards (whole-directory scan: every CRM table desktop-gated, every table file has a card path, no bare overflow-x-auto, both coverage boards moved together)", runCrmMobileTableCardTests);
await runTest("Outstation mobile table cards (whole-directory scan: every outstation table desktop-gated, every table file has a card path, no fixed-pixel floor in an ungated scroll box, HR decision controls shared by both halves)", runOutstationMobileTableCardTests);
await runTest("HR shell mobile tables (closure scan from the HR sidebar: every wide table desktop-gated with a mobile half beside it, stacking primitives pinned, exemptions justified)", runHrShellMobileTableTests);
await runTest("Doctor Coverage drill-down is windowed (both halves draw the same page, page clamps, controls exist, xlsx export still spans every row, call list cap intact)", runDoctorCoveragePaginationTests);
await runTest("RSC boundary (no server component hands a function prop to a client component — the crash that 500d Doctor Coverage; follows the real import graph so client-parent files are not flagged)", runRscClientFunctionPropTests);
await runTest("direct orders invoice scan (a dim page gains real contrast, a failed prepare returns the original, EXIF rotation is applied, no binarisation, the reader is sent the PREPARED image)", runDirectOrdersInvoiceScanTests);
await runTest("direct orders Arabic search (every fold survives, the strip class never swallows a letter, an unnamed customer is ranked down not hidden, both birth paths are searched)", runDirectOrdersArabicSearchTests);
await runTest("CRM brick-centroids cache (shared Data Cache not a per-segment module var, 300s TTL unchanged, sos-reference tag, DB read byte-identical, catch OUTSIDE the cache so a transient error is never cached as [])", runCrmBrickCentroidsCacheTests);
await runTest("direct orders area auto-fill (the body carries pointers only, the server copies the catalogue row and fails closed, a picked pharmacy never carries client geography)", runDirectOrdersAreaAutofillTests);
await runTest("direct orders extra area grants (B-76 gets Alex-BHR, nobody else gets anything, the grant widens the seat bound instead of replacing it, and only the Direct Orders service may read it)", runDirectOrdersExtraAreaGrantTests);
await runTest("direct orders share-link controls (export-gated not read-gated, passcode in the body never the URL, expiry mandatory and capped, scope frozen at creation, nothing cached or indexed)", runDirectOrdersShareLinkControlsTests);
await runTest("direct orders invoice prefill (an unconfirmed code prefills nothing, unmatched lines are named not dropped, the reader is never announced, mounted on BOTH forms)", runDirectOrderInvoicePrefillTests);
await runTest("direct orders validation registry gate (both declared actions are actually invoked, request passes the row's real status, decide is NOT coupled to it)", runDirectOrderValidationRegistryGateTests);
await runTest("direct orders pharmacy rejected state (a rejected pharmacy never reads as verified, rejecting deactivates and closes its orders, confirming cannot undo it)", runDirectOrderPharmacyRejectedTests);
await runTest("direct orders held lane (unknown pharmacy submits HELD outside the chain; validation, the 14-day clock and a requester withdrawal are the doors out; one To/Cc email per event)", runDirectOrdersHeldLaneTests);
await runTest("direct orders pharmacy validation (live-capture evidence only, server-side GPS verdict, probation can fail an approved pharmacy, suggestions are reproducible evidence)", runDirectOrdersPharmacyValidationTests);
await runTest("analytics confidential product_code normalize (sos_fact/weekly_fact/dim_products case-insensitive exclusion)", runAnalyticsConfidentialProductCodeNormalizeTests);
await runTest("analytics dim_products excludes confidential Head Office line (filter dropdown leak fix)", runAnalyticsDimProductsHeadOfficeExclusionTests);
await runTest("migrations secdef revoke guard (new public SECURITY DEFINER fns must revoke PUBLIC EXECUTE)", runMigrationsSecdefRevokeGuardTests);
await runTest("territory drilldown root-scope line resolution (fail-closed)", runTerritoryRootScopeTests);
await runTest("territory drilldown pharmacy line filter (defense in depth)", runTerritoryLineFilterTests);
await runTest("territory drilldown internal self-reconciliation", runTerritoryReconciliationTests);
await runTest("au seat-occupant resolution (period-aware, no newest-row wins)", runAuSeatOccupantResolverTests);
await runTest("au hire_into_seat wiring (replacement-hire vacancy fill trigger)", runAuHireIntoSeatWiringTests);
await runTest("sales IMS ratio integrity (non-OT areas + OT region total exactly 1)", runSalesImsRatioTests);
await runTest("HR_ID core helpers (canonical alias, cross-format match, lookup keys)", runHrIdCoreHelpersTests);
await runTest("marketing ROI cohorts (efficiency, coverage, forecast accuracy, multi-role fan-out)", runMarketingRoiCohortsTests);
await runTest("GitHub workflow validity (no `secrets` context inside `if:` — it invalidates the whole file)", runGithubWorkflowValidityTests);
await runTest("CI <-> package.json gate parity (a check:* in the gate must run in a workflow)", runCiGateParityTests);
await runTest("password setup email resolution (work_email fallback, never the synthetic auth address)", runPasswordSetupEmailResolutionTests);
await runTest("schema shape check (catches the 2026-07-31 grant wipe AND the skeleton-schema restore)", runSchemaShapeCheckTests);
await runTest("secret pins check (catches the version pinning that 401'd every cron)", runSecretPinsCheckTests);
await runTest("sql backup placement (catches snapshot tables created in the anon-readable public schema)", runSqlBackupPlacementTests);
await runTest("automated payroll step detail (breakdown foots to the row total; the 3 Part-2 windows stay distinct)", runAutomatedPayrollStepDetailTests);
await runTest("migrations Cairo date guard (no unzoned current_date in new SQL function bodies)", runMigrationsCairoDateGuardTests);
await runTest("automated payroll rejected expenses (an HR rejection must not be reimbursed; pending still flows)", runAutomatedPayrollRejectedExpensesTests);
await runTest("automated payroll expense resync (an approval changed after the step was confirmed must reach payroll)", runAutomatedPayrollExpenseResyncTests);
await runTest("automated payroll reads the Deductions module (only what HR confirmed reaches the sheet; unknown statuses fail closed)", runAutomatedPayrollReadsDeductionsModuleTests);
await runTest("automated payroll manual expenses + Part 2 non-employees (a hand-added employee survives reload; a Part 2 non-employee reaches the bank file)", runAutomatedPayrollManualExpensesAndPart2NonEmployeesTests);
await runTest("field workforce Thursday half day (Thu costs 0.5; Sat title-dependent; holiday-outage guard)", runFieldWorkforceThursdayHalfDayTests);
await runTest("deductions no-records scope (crm owns the field workforce; Head Office keeps its only coverage; SFE Manager never deducted)", runDeductionsModuleNoRecordsScopeTests);
await runTest("outstation approved amount (payroll pays HR's approved figure, not the claim; null still pays the claim)", runOutstationApprovedAmountTests);
await runTest("outstation approval state (3-state queues partition exactly; approval beats a stale rejected status)", runOutstationApprovalStateTests);
await runTest("outstation expense approval decisions (an app-submitted request is decided through the outstation workflow, not the expense upsert; a trimmed figure survives the reload)", runOutstationExpenseApprovalDecisionsTests);
await runTest("outstation expense approval filters (trip months bucket in Cairo, not UTC; one employee is one option even when their HR ID never mapped)", runOutstationExpenseApprovalFiltersTests);
await runTest("api session-expired response (an expired session answers 401 sign-in, not a 403 permissions denial; a signed-in caller still gets their own 403)", runApiSessionExpiredResponseTests);
await runTest("outstation expense approval summary (per-employee roll-up buckets every trip once; approved money is HR's figure, rejected money is the claim)", runOutstationExpenseApprovalSummaryTests);
await runTest("outstation expense approval export (before/after deduction pair, status label, distance flag, and the SAME shared filters as the queue)", runOutstationExpenseApprovalExportTests);
await runTest("outstation workload evidence (solo days count as worked; campaign cap keeps double-visit counts)", runOutstationWorkloadEvidenceTests);

await runTest("crm rep-day check-in attribution (managers borrow the rep's check-ins; an ordinary rep's route is unchanged)", runCrmRepDayCheckinAttributionTests);

await runTest("biometric passkey login (terminal-employment gate, replay counter, single-use challenge, no credential enumeration)", runAuthWebauthnTests);

await runTest("SFE doctor coverage (A=2/B=1 norms, the panel is the rep's ASSIGNED list, off-list reported never scored, identity reconciled across both mirrors, single-source door)", runSfeDoctorCoverageTests);
await runTest("Doctor coverage districts (a manager's panel is his TEAM's lists combined, MEMBERSHIP is structural and never by job title, a manager leaves the rep table, a manager whose only report produced no row is still a district, a Product Manager is exempt from the no-list tally but keeps his rep row, cycles terminate)", runDoctorCoverageDistrictTests);
await runTest("Doctor coverage rep names (the employee directory names the person and the CRM keeps the territory, a territory-only CRM name still yields a person, a district carries no territory)", runDoctorCoverageRepNameTests);
await runTest(
  "doctor coverage scope (full subtree, line boundary, fail-closed) and elapsed-month pace",
  runDoctorCoverageScopeTests,
);
await runTest(
  "doctor coverage norms (SP/HCP taxonomy, admin-editable visits per grade, 0 = not scored not green)",
  runDoctorCoverageNormsTests,
);

await runTest("push enable hang (a blocked browser resolves instantly instead of freezing the settings panel forever)", runPushEnableHangTests);

await runTest("push register hr id guard (a session with no employee behind it is skipped, not written as hr_id NULL into a NOT NULL column)", runPushRegisterHrIdGuardTests);

await runTest("live sheet stale banner (no failure path in either Apps Script returns silently; the banner names when the data froze, stays quiet while nothing changes, and clears itself on recovery)", runLiveSheetStaleBannerTests);

await runTest("visit contact kind (pharmacy/institution/doctor split is display-only — decision.ts stays pharmacy-blind)", runVisitContactKindTests);

await runTest("brevo failover keepalive (GET /v3/account only — never a send; a rejected key fails loudly)", runBrevoKeepaliveTests);

await runTest("root redirect (\"/\" resolves from the signed cookie alone so proxy.ts can answer a real 307, never a JS-only redirect)", runRootRedirectHttp307Tests);

await runTest("attendance monthly summary (a device-ingestion outage is reported as missing data, never as employee absence)", runAttendanceMonthlySummaryOutageTests);

await runTest("payroll batch membership is historical (a resignation after payday cannot remove someone from the month they were paid for, incl. the bank file)", runPayrollBatchMembershipTests);

await runTest("deductions By Employee total counts only what publish will actually take (pending shown separately, agrees with Overview)", runDeductionsEmployeeSummaryPublishEligibilityTests);

await runTest("one employee-day of unpaid vacation is chargeable once regardless of which source found it (re-run supersedes, collisions seen within a category)", runDeductionsVacationDayDoubleChargeTests);

await runTest("marketing ROI company totals count each invoice line once even when several campaigns claim it", runMarketingRoiSharedAttributionTests);

await runTest("CEO landing counts (vacancies dedup by seat + occupancy like the organogram; probation counts match what the destination can show)", runCeoLandingSeatAndProbationCountsTests);

await runTest("SoS Top Customers aggregates by distributor+client across selected months instead of duplicating a customer per month", runSosTopCustomersAggregationTests);

await runTest("CRM-fed portal ratios divide comparable populations (no >100% coverage) and multi-day calendar items span their full range", runCrmPortalCoveragePopulationsTests);

await runTest("exports answer the same question as the screen that launched them (direct orders + company vacation report + monthly closing Office)", runExportFollowsScreenFiltersTests);

await runTest("one human receives one notification (person-level recipient dedup), in_app is only claimed for categories the bell renders", runNotificationDeliveryIntegrityTests);

await runTest("outstation metrics use the canonical 3-state approval detector (rejected is never pending; Approved means the payable everywhere)", runOutstationExpenseApprovalStateMetricsTests);
await runTest("CRM unmapped-agent alerts (invisible-work tripwire: new/reused/drifted identities alert, historical stay silent, weekly idempotency key)", runCrmUnmappedAgentAlertTests);
await runTest("CRM unrecognized visit-type alerts (a code nobody classified alerts; all 16 production codes stay silent; recognized set stays derived from the two Sets)", runCrmUnrecognizedVisitTypeAlertTests);

await runTest(
  "payroll ⨯ deductions gate composition (payroll never pays what the module refuses to publish; dsm_no_record never auto-publishes into a sheet; holiday_bridge reaches the other bucket)",
  runPayrollDeductionGateComposesWithPublishRuleTests,
);

await runTest("July 2026 direct orders (closed month still totals 684,002.15 / 5,241 units after the 2026-08-06 Anti Infective restatement; value is carried per-deal, never units × factory price)", runJuly2026DirectOrdersTabTests);

await runTest(
  "direct value is taken AS STORED, in EVERY month (owner's ruling 2026-08-06: Anti Infective July "
  + "direct is 149,288.50, never the 157,518.00 a factory-price recompute gives — widened past July "
  + "on 2026-08-25; the mapping and the month's direct sales stay one number)",
  runJuly2026DirectValueIsStoredTests,
);

await runTest(
  "booked direct orders are INSIDE the closing headline (the Finance Manager's Details tab read "
  + "\"In closing 0.00\" beside the 290,387.57 he had just booked into 2026-08; the headline is the "
  + "two channels added, confidential excluded, and `includedInClosing` still means the distributor "
  + "half alone)",
  runClosingHeadlineCountsDirectTests,
);

await runTest("incentive semester window (the CALENDAR semester, the same one for every rep; H1 stays closed rather than restated; a rep with no data still gets a named provisional window)", runIncentiveSemesterWindowTests);

await runTest("reconciliation harness (a breach names both figures and their sources; a known-open defect never pages nightly; one bad check cannot blind the rest)", runReconciliationHarnessTests);
await runTest("outstation submit email envelope (employee To, managers Cc, Super Admins Bcc; a CEO skip-level is dropped but a CEO direct manager is kept; one mailbox never lands in two headers)", runOutstationSubmitEmailRoutingTests);
await runTest("outstation two-photo + workload payroll gate (both photos AND a captured workload before payroll; a 'complete' status with no photo behind it never pays; pre-rule requests are exempt, not blocked)", runOutstationExpenseGateTests);
await runTest("outstation departure photo review (distance is flagged not blocked; both photos at once is flagged; the window closes at the end of the trip's last CAIRO day, DST included)", runOutstationDepartureEvidenceTests);
await runTest("evidence photo location stamp (full address + Phoenix brick/area/region; a far brick carries its distance; NO line is ever a bare lat/long pair)", runEvidenceLocationStampTests);
await runTest("evidence photo watermark panel (grows to hold the location block; nothing is drawn past the bottom edge; shrinks the font rather than truncating)", runEvidencePanelLayoutTests);
await runTest("workflow registry retarget guard (a migration must never point an action at a status no code expects — the mismatch that wedged every outstation submit on 2026-08-04)", runWorkflowRegistryRetargetGuardTests);
await runTest("outstation workload repair (a hand-entered figure is refused not coerced; a blank box is never a measured zero; a re-grab restates the match status so the row cannot contradict itself; the retry reports the release's own reason; the panel lists what the GATE holds rather than only what was accepted, never a rejected request, and never a trip still running; both repairs are Super Admin only, the list is read-only)", runOutstationWorkloadRepairTests);
await runTest("outstation departure-photo reminder (only the departure blocker triggers it; never before the trip's last day; the LAST-DAY reminder had never once fired in production because the 06:36 job cannot see a request submitted at 20:49, so the submit path raises it too; the email must name its subject employee or it is skipped outright)", runOutstationDeparturePhotoReminderTests);
await runTest("outstation departure-photo resend (the one action that deliberately steps around delivery dedupe — a claimed key can never send again, which is how eight real reminders went silent; the automatic key must stay the DEFAULT or shipping it re-mails every historic hold; approve-level only, so the read-only CEO cannot mail employees; refuses a row not held on that photo; obeys the same timing rule so it cannot nag mid-trip; keyed on the CAIRO date; audited)", runOutstationDeparturePhotoResendTests);
await runTest("outstation manager workload rollup (a DM's ride-alongs are already his; an NSM reaches one hop but only on the days he was actually out with that DM; a shared rep counts once)", runOutstationWorkloadRollupTests);

await runTest("sales vs target (no target reads as null not 0%, July 2026 has no prior period, and a medical rep is bounded to their own rows not their whole line)", runSalesVsTargetTests);
await runTest(
  "business review window + coverage (a period with no data SAYS so and never renders a zero: Mar-Jun grade as \"not gradeable\" rather than 0%, a pre-August window reports no marketing rather than 0 EGP, a month whose distributor files have not landed is held out of the grade and named with the value it does hold rather than dragging Jan-Aug from 50.67% to 39.30%, every clamp announces itself, unplaceable rows are counted not dropped, and doctors are unioned at every level while rides land where the rep stood)",
  runBusinessReviewWindowAndCoverageTests,
);
await runTest(
  "business review portal scope (every one of the 27 viewers in the committed access map resolves to a real scope rather than a link that lands on \"no access\", a grant is refused the moment the live session role disagrees with the snapshot it was written from, no HR ID and an HR ID outside the map are both denied with a reason that says whether it is a fault or the Medical Rep design, every district a viewer is handed exists in that line's dataset, and a seat filter with nothing in it shows an empty page rather than falling through to the whole company)",
  runBusinessReviewPortalScopeTests,
);
await runTest(
  "business review achievement arithmetic (a percentage is re-aggregated by summing the parts it divides, never by dividing the full sales figure: the company headline, a district manager's own portal total and the product-family mix all divide covered sales by target, so a month carrying sales nobody set a target for cannot lift the grade -- the defect that made Jan-Aug 2026 read 130.73% where it means 50.67%, and an ungraded area still reports its sales while grading as null rather than 0%)",
  runBusinessReviewAchievementArithmeticTests,
);
await runTest(
  "targets rollup achievement (the admin and portal Targets pages share one fold, and it divided ALL sales by the COVERED target -- Pedia February 2026 read 67.99% for a 35.71% month and one district manager read 48.5% for a 2.2% July; the grade now divides the graded slice, an untargeted return may legitimately exceed the full actual and is never clamped, a month with no target grades null and never 0%, and both pages show WHICH sales were graded so the card's own arithmetic divides out)",
  runTargetsRollupAchievementTests,
);
await runTest(
  "achievement counts the unmapped channel (no channel filter survives, the line_code rejoins are NULL-safe so a line-less sale is not zeroed, and service_role keeps execute)",
  runAchievementCountsUnmappedTests,
);
await runTest(
  "achievement rejoins on a hashable join_key (folds the four NULL-safe key columns into one =, so the two IS NOT DISTINCT FROM nested loops become hash/merge joins; PARALLEL SAFE re-declared; output identical)",
  runAchievementHashableJoinKeyTests,
);
await runTest("direct orders registry grants every chain rung (SFE can return/reject/advance, never finalize or submit)", runDirectOrdersRegistryChainGrantsTests);
await runTest(
  "SoS customer channel (six words ⇒ store, مستشف ⇒ hospital and it wins the overlap without stopping the closing's city split; ة/ه fold; channel totals cover the whole side)",
  runSalesCustomerChannelTests,
);
await runTest(
  "CEO marketing approval inbox (the final rung reaches page, sidebar link and decision page in the admin shell; the opt-in widens nothing else)",
  runCeoMarketingApprovalInboxTests,
);

await runTest(
  "store sales city split (a store's sales divide evenly across its city's AREAS; total preserved exactly; Head Office and pharmacies untouched)",
  runStoreSalesCitySplitTests,
);

await runTest(
  "closing export honours a hand-split customer (441164 stays on D22/D26 at -400 units / -34,380; detection reads the FACT area, not the brick-resolved one)",
  runClosingStoreSplitHonoursManualSplitTests,
);

await runTest(
  "closing store split risk follow-ups (Details/Rankings/Gaps agree with the Matrix's area; a genuine two-depot wholesaler still splits; the Channel Breakdown brick grid never debits an exempt customer's brick)",
  runClosingStoreSplitRiskFollowupsTests,
);

await runTest(
  "store split applied to the closing matrix (sales move between areas, TARGETS are never touched, achievement re-derives, grand total holds)",
  runStoreSplitMatrixTests,
);

await runTest(
  "monthly closing export writes the matrix static (no cell reaches the Calc sheet; split-touched, direct-carrying and untouched rows all carry the screen's own figure)",
  runMonthlyClosingExportSplitStaticTests,
);

await runTest(
  "exported Closing Matrix equals the screen (no Calc-sheet formula survives anywhere on the grid, organogram region subtotals and merged direct export at their on-screen value, and the fixture still reproduces the SUMIFS-to-zero bug)",
  runClosingExportMatchesScreenTests,
);

await runTest(
  "Performance Review never names a system state and never adds units across products (no \"Not mapped to an area\" / \"No district manager\" anywhere in the workbook, Main Store keeps its own name, the by-area growth tab is value-only, and a month never uploaded renders as a dash)",
  runClosingPerformanceReviewTests,
);

await runTest(
  "several closing months merge by PRODUCT CODE, never by column position (two months carrying the same products in different orders each keep their own units, a month with no target contributes nothing rather than a zero, achievement is summed value over summed target, and merging nothing throws instead of returning an all-zero closing)",
  runMonthlyClosingPeriodMergeTests,
);

await runTest(
  "a Performance Review filter narrows the rows but never the pickers, and a filtered or multi-month workbook says so (Delta stays offerable after filtering to Cairo, a real area carrying direct money stays in the area picker while the synthetic company row does not, three months are labelled as a span instead of as September, and an array body parses the same as a comma query)",
  runClosingReviewFilterTests,
);

await runTest(
  "marketing approval inbox nav badge (gating rows only — not CC, not upcoming, not a request that already left pending_approval; overdue on the step's own default_sla_days, never on a null one)",
  runMarketingApprovalInboxNavBadgeTests,
);
await runTest(
  "marketing approval history on the inbox row (ordered, CC excluded, credits the decider, silent approvals named)",
  runMarketingApproverChainHistoryTests,
);

await runTest(
  "marketing approver customer history (clean slate vs unmeasured vs failed lookup are three different answers; a measured zero survives)",
  runMarketingApproverCustomerHistoryTests,
);

await runTest(
  "marketing sales evidence access (company-wide roles only by role; confidential LA003/LA004/SS001 stripped for everyone but CEO/Super Admin)",
  runMarketingSalesEvidenceAccessTests,
);

await runTest(
  "marketing request case file (a failed read is never a clean one; a draft/rejected request is never dropped by the ROI status scope; too-early is not zero sales)",
  runMarketingCaseFileTests,
);

await runTest(
  "marketing case file 'Go deeper' drill-downs open in place (the four panels render inline, never a full-navigation link at the raw JSON API route)",
  runMarketingCaseFileGoDeeperTests,
);

await runTest(
  "marketing rejected-request visibility (a requester can see their own refusal and its reason; the refusing rung is credited, not the last rung; Cairo not UTC)",
  runMarketingRejectedRequestVisibilityTests,
);

await runTest(
  "marketing request case file page (the notification URL finally renders the request; one-tap decisions still redirect; a failed read never renders as an empty one)",
  runMarketingRequestCaseFilePageTests,
);

await runTest(
  "marketing request events (append-only survives TRUNCATE and the owner's own privileges; events outlive a deleted request; a backfilled row is never mistaken for a captured one)",
  runMarketingRequestEventsMigrationTests,
);

await runTest(
  "marketing self-approval refused (the requester cannot decide their own request at the chain, the service or the RPC; casing does not defeat it; a different approver still can)",
  runMarketingSelfApprovalTests,
);

await runTest(
  "marketing reject terminalises the chain (later rungs stop reading as pending work, the return is no longer erased, decided rungs and a RETURN are untouched)",
  runMarketingRejectTerminalisesTests,
);

await runTest(
  "marketing request history (a comment the step row overwrote is still visible; a failed read is never an empty timeline; an unrecorded actor is never 'the system')",
  runMarketingRequestHistoryTests,
);

await runTest(
  "marketing progress strip (a finished request stops claiming a named colleague is holding it; the status is a required prop)",
  runMarketingProgressStripStatusTests,
);

await runTest(
  "marketing work queue page (/marketing-requests finally exists; a failed read is never an empty queue; scoped by actor, not by a role switch)",
  runMarketingWorkQueuePageTests,
);

await runTest(
  "marketing config table grants (the browser roles lose TRUNCATE, which no RLS policy could ever stop; SELECT and service_role survive)",
  runMarketingConfigGrantsTests,
);

await runTest(
  "closing source coverage (missing vs new vs present on rows not value; confidential skipped; direct region drop-out surfaces)",
  runSourceCoverageTests,
);

await runTest(
  "organogram dual-seat visibility (a person on two au seats renders two boxes, never a silent drop)",
  runOrganogramDualSeatVisibilityTests,
);

await runTest(
  "seat transfer service (Super Admin gate, trimmed RPC args, SQL guard messages surface)",
  runSeatTransferServiceTests,
);

await runTest(
  "filtered monthly closing export, city straddling the filter (Total sheet Difference is zero, the share belonging to excluded areas is named, and the export uses the SCREEN's split rather than deriving a second one)",
  runMonthlyClosingExportStoreSplitFilteredTests,
);

await runTest(
  "row-level filtered export keeps its direct money (Distributor = DIRECT is a real slice, named on the Total sheet, not a matrix of zeros)",
  runClosingFilteredExportKeepsDirectTests,
);

await runTest(
  "closing corrections grouping (pair names both distorted months; late return names its origin or admits none; worst first)",
  runClosingCorrectionsTests,
);

await runTest(
  "territory scope UE-split bridge (coarse UE matches UE-1/UE-2; no widening for unsplit or already-split codes)",
  runTerritoryScopeLineAwareTests,
);

await runTest(
  "territory preview links (passwordless: export+Super Admin to mint, mandatory 14-day expiry, frozen area list, analysis and line projected out)",
  runTerritoryPreviewLinkControlsTests,
);

await runTest(
  "closing channel tabs (retail + direct partition the master exactly, survive the store split, and say Contr%)",
  runClosingChannelTabsTests,
);

await runTest(
  "closing channel sheets drop nothing (no-client-code bucket, unnamed direct is not a pharmacy, "
  + "grids carry the Matrix's store split, self-check covers every month)",
  runClosingChannelNothingDroppedTests,
);

await runTest(
  "closing channel rollup equivalence (reads the precomputed rollup not a live scan; two-bucket "
  + "arithmetic; presence on row count; classifier order; exclude-set guard; per-batch refresh wired "
  + "everywhere after the trio)",
  runClosingChannelRollupEquivalenceTests,
);

await runTest(
  "closing distributor-product rollup equivalence (reads the precomputed rollup not a live fact scan; "
  + "factory_price stays LIVE so a price edit reprices history; units-only baked; same exclusions; "
  + "per-batch refresh wired everywhere after the fact rollup)",
  runClosingDistributorProductRollupEquivalenceTests,
);

await runTest(
  "closing channel breakdown reuses the channel rollup (name+fold precomputed, classifier no longer "
  + "folds per row; money stays live; population stays an INDEPENDENT source-tables re-read, not "
  + "sum(tagged); CASE order and emitted array preserved)",
  runClosingChannelBreakdownRollupEquivalenceTests,
);

await runTest(
  "monthly attribution rollup equivalence (sales-vs-target: gated reader reads the precomputed rollup "
  + "not a live recompute; covered path shares the achievement math BYTE-FOR-BYTE with the live "
  + "fallback; gate falls back on no-coverage OR config drift; fingerprint covers exactly the five "
  + "config tables; per-batch refresh wired into every fact-refresh path after the fact rollup)",
  runMonthlyAttributionRollupEquivalenceTests,
);

await runTest(
  "monthly closing Channel Comparison sheet (owner-reviewed Anti Infective split; customers peak not summed; target is month-total only)",
  runMonthlyClosingChannelsTests,
);

await runTest(
  "vacancy seat linkage (seat_id FK, one open vacancy per seat, hire resolves by seat before text matching)",
  runVacancySeatLinkageTests,
);

await runTest(
  "closing excludes Head Office (unreachable on every closing surface; the published-everything email gate still counts it)",
  runClosingExcludesHeadOfficeTests,
);

await runTest(
  "store split detail report (mirrors the split exactly; shares add back to the sale; pharmacies and direct never appear)",
  runStoreSplitDetailReportTests,
);

await runTest(
  "closing region grouping follows the EU Organogram for Anti Infective, Pedia, and CNS (gate consulted before the fetch)",
  runClosingRegionGroupingPerLineTests,
);

await runTest(
  "payroll fractional deduction days (a 0.13-day late arrival charges 377.42 EGP, never a whole day at 2,903.23)",
  runPayrollFractionalDeductionDayScalingTests,
);

await runTest(
  "deductions CRM single month scan (one shared company-wide visit scan, never one per leaver — a wider window cannot change a leaver's charge)",
  runDeductionsCrmSingleMonthScanTests,
);

await runTest(
  "CRM day-map pushdown (a bounded employee set is fetched by index and merged into the exact one-row-per-id, id-ascending shape a single company-wide scan produced)",
  runCrmDayMapPushdownTests,
);

await runTest(
  "SFE Manager admin sales/customers-database nav cards never dead-end into a Super-Admin-only redirect",
  runSfeManagerNavDeadLinksTests,
);

await runTest(
  "an organogram nav link exists for every role that can OPEN the organogram (Talent Acquisition and "
  + "Training Manager both held organogram:read and passed canAccessCompanyOrganogram, so the page rendered "
  + "the whole chart on request — but neither was listed on any sidebar entry, so there was no way to reach "
  + "it; the owner hit this on 2026-08-25 after the Head Office branch shipped)",
  runOrganogramNavLinkExistsTests,
);

await runTest(
  "every link a role is OFFERED must OPEN for that role (the general form of the four single-page "
  + "reachability tests around it, across BOTH shells: admin links via getSections, portal links via the "
  + "nav registry's role-driven visibility flags, each resolved to its page file and checked against that "
  + "page's own unconditional assertPermission / canAccess gate; the portal's flags are computed from role "
  + "names and never consult the permission matrix, which is why it offered Talent Acquisition "
  + "/employee-portals/probation while the matrix withheld probation:read — production logged 25 "
  + "\"Forbidden: Talent Acquisition cannot read probation\" errors across 8 route variants on "
  + "2026-07-25/26 before 41c24ede added the missing line)",
  runEveryOfferedLinkOpensTests,
);

await runTest(
  "a CRM hub card is reachable by the role it names (Rep Doctor Lists and Reps Plans are both "
  + "roles: [\"Super Admin\"] cards on /admin/crm-tools, the one page that renders crmPageItems — and "
  + "that hub's sidebar row excludes Super Admin by name, so the only role either card admitted was "
  + "the only role that could not see the hub holding it; both pages rendered fine on a typed URL)",
  runCrmHubCardReachabilityTests,
);

await runTest(
  "CRM live departed-exclusion handover (a crm_id reassigned to a currently active employee is no longer blanket-hidden — AI-0006/B-97 slot 1399 incident)",
  runCrmDepartedExclusionHandoverTests,
);

await runTest(
  "the arrival-photo capture stays reachable for every transport type the validator refuses to exempt",
  runOutstationArrivalPhotoCaptureReachableTests,
);

await runTest(
  "every photo-less write path declares its evidence gate instead of inheriting the fail-closed default",
  runOutstationAdminManualExpenseGateTests,
);

await runTest(
  "a departure photo may be retaken only inside the trip window, and never by overwriting the one it replaces",
  runOutstationDeparturePhotoRetakeTests,
);

await runTest(
  "one employee earns at most one allowance per calendar day, across every write path",
  runOutstationAllowanceDuplicateDayGuardTests,
);

await runTest(
  "a regional employee's trip to Cairo earns no per-diem allowance, across every write path",
  runOutstationCairoNoAllowanceTests,
);

await runTest(
  "outstation claim validation flags a real mismatch and never reads missing CRM data as one",
  runOutstationClaimValidationTests,
);

await runTest(
  "an approval note is rewritten in the system's voice and can never invent a figure",
  runOutstationExpenseNoteAssistTests,
);

await runTest(
  "an outstation claim waits for a human — no submit path can approve itself into payroll",
  runOutstationSubmissionWaitsForApprovalTests,
);

await runTest(
  "direct orders pharmacy standing (spec D2: an empty sales table explains itself in words; a null probation clock is never day zero; the footprint query names the column SoS actually has)",
  runDirectOrdersPharmacyStandingTests,
);

await runTest(
  "direct orders pharmacy combo box opens where there is room (measured against visualViewport, flips up, never a fixed 320px)",
  runDirectOrdersPharmacyComboboxPlacementTests,
);

await runTest(
  "direct orders pharmacy code collision (one transaction so a failed code insert cannot leave an orphan pharmacy; the collision is asked as a question naming the incumbent; \"no\" registers without the code and records the dispute; the name question covers the codeless case; My Pharmacies offers only settled ones)",
  runDirectOrdersPharmacyCodeCollisionTests,
);

await runTest(
  "direct orders basket label (a multi-product order names EVERY product against its whole-basket value, quantities summed; a one-product order stays byte-identical for the owner's Google Sheet; the card renders one line per product rather than truncating a joined string)",
  runDirectOrdersBasketLabelTests,
);

await runTest(
  "direct orders sheet editable columns (the team's notes are keyed to the Request ID, captured before the sheet is wiped or reordered, live outside every range the refresh rewrites, and the real sales month stays Phoenix's alone)",
  runDirectOrdersSheetEditableColumnsTests,
);

await runTest(
  "sales pharmacy override (owner ruling beats the keyword, split stops moving their money)",
  runSalesPharmacyOverrideTests,
);

await runTest(
  "SoS self-heal never overwrites an owner-verified (confidence=100) customer mapping, and the guard is keyed on (distributor, customer) exactly as the upsert is",
  runSosSelfHealOwnerVerifiedGuardTests,
);
await runTest(
  "manual admin outstation expense adds the ticket price to the allowance instead of replacing it (travelCostAmount reaches the create route)",
  runOutstationManualExpenseTicketPlusAllowanceTests,
);
await runTest(
  "an area carrying July direct keeps its own code/name (screen + XLSX) and stays in seat scope; only areaCode=DIRECT is the company row",
  runClosingDirectAreaIdentityTests,
);
await runTest(
  "Fayoum/Beni Suef merged Closing Matrix row exports its combined total (Pedia/CNS), flagged or not, and no cell can SUMIFS the fold away",
  runMonthlyClosingExportAreaMergeStaticTests,
);
await runTest(
  "store-override forces a keyword-less wholesaler (ابن خلدون, 446299) to channel=store and into the city split, mirroring the pharmacy override in reverse",
  runSalesStoreOverrideTests,
);
await runTest(
  "the closing workbook download is named by month, line and region (and never by a raw period code)",
  runClosingExportFilenameTests,
);
await runTest(
  "District Manager weekly/monthly plans skip the CEO decide stage (server guard, no CEO notification, HR bucket, read-only CEO queue)",
  runWeeklyPlansDistrictManagerBypassTests,
);
await runTest(
  "a notification email never substitutes the shared HR inbox for a recipient whose address failed to resolve",
  runNotificationRecipientAddressResolutionTests,
);
await runTest(
  "no email leaves the system unless every address is accounted for and the intended person is actually addressed",
  runRecipientAssuranceGuardTests,
);
await runTest(
  "automated payroll run-scoped exclusion (excludeEmployeeFromRun's population filter)",
  runAutomatedPayrollExcludedMembersTests,
);
await runTest(
  "direct order pharmacy evidence visibility (requester never sees the AI note, the read path stays ungated, both approval screens share one renderer)",
  runDirectOrderEvidenceVisibilityTests,
);
await runTest(
  "direct order held fork (the distributor code is the proof; a brick mismatch still holds; placeholders prove nothing)",
  runDirectOrderHoldReleaseTests,
);
await runTest(
  "direct order duplicate cleanup (one pharmacy entered twice, one order submitted twice — and neither merges on a name)",
  runDirectOrderDuplicateCleanupTests,
);
await runTest(
  "NSM/RM CRM First Visit board (GPS-first ranking, a clockless submission still ranks, first 10 early birds, and passing the cap never returns you to the red list)",
  runNsmCrmComplianceTests,
);
await runTest(
  "campaign account extraction guard (the model may delimit a name already in the rep's note, never author one)",
  runCrmCampaignAccountTests,
);
await runTest(
  "early birds fortnight (Cairo 1st-15th / 16th-end, a period is not closed on its own last day, and the TS key pattern equals the SQL CHECK)",
  runEarlyBirdsPeriodTests,
);
await runTest(
  "early birds scoring (only a real GPS check-in is a start time, an after-midnight save is paperwork not a 02:25 start, and two brilliant mornings is not a fortnight)",
  runEarlyBirdsScoringTests,
);
await runTest(
  "early birds decisions (reject falls through by rank, a rejected rep can never be offered again, and an unanswered fortnight auto-approves on day five)",
  runEarlyBirdsDecisionTests,
);
await runTest(
  "early birds scope (an NSM is scoped by LINE, and no line's manager can ever see another line's district)",
  runEarlyBirdsScopeTests,
);
await runTest(
  "early birds line stars (one star per LINE, never a company-wide best-of-the-best, so a rep always sees their own line)",
  runEarlyBirdsLineStarsTests,
);
await runTest(
  "departed-agent CRM scan (one-statement distinct, page-walk fallback, no silent empty exclusion)",
  runCrmDepartedAgentScanTests,
);
await runTest(
  "api error redaction (Postgres text never reaches the client; our own prose still does)",
  runApiErrorInfrastructureRedactionTests,
);
await runTest(
  "schema-shape default ACLs (the loaded gun is an error; the unfixable supabase_admin row stays a warning)",
  runSchemaShapeDefaultAclTests,
);
await runTest(
  "schema-shape private USAGE (missing grant makes every dependent RLS policy untestable; no dependents means no demand)",
  runSchemaShapePrivateUsageTests,
);
await runTest(
  "territory sync (rollup==source reconciles within epsilon; row-count off-by-one fails; period window clamps)",
  runTerritorySyncTests,
);
await runTest(
  "finance command center (deductions from committed payroll only; one round trip; unbooked predicate parity)",
  runFinanceCommandCenterTests,
);

await runTest(
  "marketing manager monthly closing (portal tab, three gates agree, full workbook, no sales:import)",
  runMarketingManagerMonthlyClosingTests,
);

await runTest(
  "portal home plan count (reads canonical countPlanAwaiting, never the superseded empty weekly_plans table)",
  runPortalHomePlanCountCanonicalTests,
);

await runTest(
  "telegram onboarding campaign cap (caller-supplied limit clamped to DEFAULT_CAMPAIGN_LIMIT, never trusted past it)",
  runTelegramOnboardingCampaignCapTests,
);

await runTest(
  "public sales exposure (no achievement data under public/, master-workbook export gated on Super Admin before the national read)",
  runPublicSalesExposureGuardsTests,
);

await runTest(
  "sos team performance active periods (a stray Direct Order booked before a month's distributor upload lands must not activate that month's full target in the default cumulative keycard view)",
  runSosTeamPerformanceTests,
);

await runTest(
  "employee achievement grouping (HR-id casing absorbed, missing target stays null never 0, unuploaded months excluded from a summed window, achievement re-derived from sums)",
  runEmployeeAchievementGroupingTests,
);

await runTest(
  "portal canonical sales rows (merged areas sum instead of one winning a MAX dedupe, un-uploaded month excluded, vacant-seat row never credited, manager reach preserved)",
  runPortalCanonicalSalesRowsTests,
);

await runTest(
  "canonical admin dashboard rows (vacant-area sales stay in the company total, HR ids upper-cased, achievement divides covered sales only, un-uploaded month excluded)",
  runCanonicalDashboardRowsTests,
);
await runTest(
  "employee-360 canonical sales (un-uploaded month dropped, unattributed rows dropped, areas summed per product, scoping matches the REP not the DM, confidential products masked by CODE)",
  runEmployee360CanonicalSalesTests,
);
await runTest(
  "national holidays drop Google 'Observance' events (cultural notes, not real days off) while keeping genuine Public holidays",
  runNationalHolidaysObservanceFilterTests,
);
await runTest(
  "thrown-error serialization (PostgrestError keeps message/code/hint, never '[object Object]'; instrumentation.ts routes through it)",
  runDescribeThrownTests,
);
await runTest(
  "manager cascade skips frozen tables (no sales_records PATCH — service_role lost UPDATE and it is the only record of what H1 was paid on; sales_targets still cascades)",
  runManagerCascadeFrozenTablesTests,
);
await runTest(
  "deleting a sales batch cannot destroy frozen sales_records (guard runs BEFORE the batch delete, refuses with a 409 the route surfaces, and the batch FK is ON DELETE RESTRICT not CASCADE)",
  runSalesBatchDeleteGuardTests,
);
await runTest(
  "phx_reassign_replacement_ownership never writes frozen sales_records (SECURITY DEFINER runs as owner, so the Rule #1 revoke does not stop it) while every other reassignment survives",
  runReassignOwnershipFrozenWriteTests,
);
await runTest(
  "user_access_profiles always syncs with an account's role, and a missing auth_user_id now logs instead of silently skipping the profile write",
  runAccessProfileSyncTests,
);
await runTest(
  "a zero-padded POS pharmacy code is found by the code the pharmacy quotes, and the canonical padded code is what gets stored so ROI still attributes",
  runMarketingPharmacyCodeCompactTests,
);
await runTest(
  "master map merge (blank names never merge, one distributor's two codes stay two shops)",
  runMasterMapMergeTests,
);
await runTest(
  "master map organogram regions (Upper Egypt 1 and 2 borrow their areas, and no shop is counted twice)",
  runMasterMapOrganogramRegionsTests,
);
await runTest(
  "master map district managers (three per shop, never blank, and appended so the finder's column letters hold)",
  runMasterMapDistrictManagersTests,
);

await runTest(
  "zoomable photos (every evidence photo opens full screen; the pinch/wheel wiring survives)",
  runZoomablePhotoTests,
);

await runTest(
  "marketing case file decision bar (the notification's own approver can answer in place, in their own shell, with only the powers their rung has)",
  runMarketingCaseFileDecisionBarTests,
);

await runTest(
  "marketing decision page Return gate (the confirmation page offers Return only on a rung that holds it)",
  runMarketingDecisionPageReturnGatingTests,
);

await runTest(
  "marketing pharmacy code match (a customer registered without the leading zeros still finds its own sales)",
  runMarketingPharmacyCodeMatchTests,
);

await runTest(
  "marketing request status label (a CEO-approved request waiting on Finance stops calling itself pending approval)",
  runMarketingRequestStatusLabelTests,
);

await runTest(
  "marketing decision confirm prompt (no approve, return or reject commits on a single unguarded click)",
  runMarketingDecisionConfirmPromptTests,
);
await runTest(
  "marketing draft blockers (named in form order, unrecognised pharmacy code included)",
  runMarketingDraftBlockersTests,
);
await runTest(
  "marketing customer area ownership (a customer belongs to a territory, so the rep hired into a resigned rep's patch inherits it with nothing re-stamped; same area other line sees it too; another area does not)",
  runMarketingCustomerAreaOwnershipTests,
);
await runTest(
  "marketing request customer scope guard (a spend request can only be raised against a customer the requester can see — both the create and the resubmit path check, before anything is written)",
  runMarketingRequestCustomerScopeGuardTests,
);

await runTest(
  "outstation evidence waiver (Product / Group Product / National Sales Managers submit with no photo, and their train-bus ticket is optional)",
  runOutstationEvidenceWaiverTests,
);

await runTest(
  "outstation National Sales Manager no-hold rule (never held by the photo or workload gate, accepted on submission, released into payroll as the system — and nobody else exempted)",
  runOutstationNsmNoHoldTests,
);

await runTest(
  "sales pharmacy-code sync re-run (twice leaves exactly one row per distributor+code, spreadsheet rows untouched, links not detached)",
  runMarketingSalesCodeSyncRerunTests,
);

await runTest(
  "territory area pharmacies area-period index (expression index on (upper(btrim(coalesce(area_code,''))), "
  + "period) matches the RPC's only selective predicate so the plan is a Bitmap Index Scan not a full "
  + "rollup seq scan; index expression and function predicate pinned to stay in lockstep)",
  runTerritoryAreaIndexTests,
);

await runTest(
  "CRM day-map visit-type ruling (third copy of AV/CP: -4 is the only leave; Health Day -15, Public "
  + "Holiday -5 and Casual Leave -6 are working time; all three copies pinned against each other)",
  runCrmDayMapVisitTypeStatusTests,
);
await runTest(
  "CV read honesty (five EMPTY arrays are not five fields; a read that produced nothing reports EMPTY, "
    + "never READ, and gets its own summary line so 'Failed: 0' cannot mean 'nothing was extracted')",
  runRecruitmentCvReadHonestyTests,
);
await runTest(
  "CV re-read hold-back is built from the exported model constants (an OCR-only row must not count "
    + "as a real model read and freeze that candidate out of every future re-read)",
  runRecruitmentRereadModelConstantsTests,
);
await runTest(
  "CV re-read target sets (a free rules row FOLLOWED by a model read is not 'rules-only' — counting "
    + "it there reported a 174-CV backlog that was already read, and advised paying to redo it)",
  runRecruitmentCvRereadTargetSetsTests,
);

await runTest(
  "CRM brick coverage (coverage weighted by selling units not brick count; a rep with no GPS "
  + "check-in that month is listed unscored and kept OUT of every total, never shown at 0%)",
  runCrmBrickCoverageTests,
);

await runTest(
  "Pharmacy Search (PostgREST or-filter sanitising, one pharmacy across many distributors, "
  + "brick table beats a stale row code, bounding box widens with latitude, null island rejected, "
  + "a hospital is never listed as a doctor, the measured distance wins the hospital merge, "
  + "save never touches sales attribution, every route asserts access, mobile gets cards)",
  runPharmacySearchTests,
);

await runTest(
  "CV extraction records is_cv (the model's 'is this a CV' answer is persisted, and every reader "
  + "gates on an explicit false so a missing judgement never discards a real applicant)",
  runRecruitmentExtractionRecordsIsCvTests,
);

await runTest(
  "CV re-read skips confirmed non-CVs (every skip entry carries its evidence, and the run reports "
  + "what it actually skipped so a stale id cannot read as coverage)",
  runRecruitmentRereadNotACvSkipsTests,
);

await runTest(
  "Worktree backup guard logs before the worktree goes (the pre-removal check names the target, "
  + "warns on unpushed commits and uncommitted files, logs the clean case too so silence cannot be "
  + "mistaken for coverage, and never blocks the removal)",
  runWorktreeExitGuardPreRemovalTests,
);

await runTest(
  "Repo doctor counts stranded work by CONTENT, not reachability (a squash-merged branch whose "
  + "remote ref GitHub already deleted is backed up and must not be flagged, work that exists "
  + "nowhere upstream still is, and a target it cannot read reports unknown rather than clean)",
  runRepoDoctorUnpushedCommitsTests,
);

await runTest(
  "The memory index is capped by a BUDGET below the loader cliff, not by the cliff itself (the old "
  + "ceiling-only rule was silent 335 bytes from silent truncation, mustFree closes the gap exactly, "
  + "and an index it cannot measure reports unknown rather than healthy)",
  runMemoryIndexBudgetTests,
);

await runTest(
  "The memory index budget reaches a session at SessionStart, not only when somebody runs "
  + "repo-doctor (the guard is registered as its own hook entry so a live session lock cannot mute "
  + "it, a worktree is graded against the PRIMARY checkout index rather than an empty one of its "
  + "own, a healthy index reports its headroom without interrupting the human, and a file it cannot "
  + "measure reports unknown rather than healthy)",
  runSessionStartMemoryIndexGuardTests,
);

await runTest(
  "google geocode precision (a query that resolves only to the country is discarded instead of "
    + "stored as the Egypt centroid, which is what put 23 employees' homes in the Western Desert; "
    + "governorates and districts still geocode)",
  runGeocodePrecisionTests,
);

await runTest(
  "outstation manager distance failures (a residence stored as the Egypt centroid is reported as "
    + "the origin's fault, before Google is called, never as an unreachable destination; a missing "
    + "Maps key is 503 named as configuration; a markaz no longer trips the region warning)",
  runOutstationDistanceFailureTests,
);

await runTest(
  "CV re-read applies what it reads (every extraction persister also writes to the candidate)",
  runCvRereadAppliesWhatItReadsTests,
);

await runTest(
  "candidate name from a CV (a low-confidence or institution-shaped extraction never becomes a "
    + "candidate's name; the CV filename is preferred over the sender, and the NOT NULL column is "
    + "always filled)",
  runCandidateNameFromCvTests,
);

await runTest(
  "legacy Word CVs (a Word 97-2003 .doc is recognised by its BYTES, not its MIME label, so it "
    + "reaches word-extractor instead of dying in mammoth - and a mislabelled real .docx still "
    + "reaches mammoth)",
  runLegacyDocCvTests,
);

await runTest(
  "CV library rows (the CV Database reads the candidate pool itself; Cairo received date, three "
    + "medical-sales answers, and no null leaking onto a screen)",
  runCvLibraryTests,
);

await runTest(
  "hiring employee scope (Hiring Documents and Hiring Pack both mean current staff, and neither "
    + "owns a second employment-status list)",
  runHiringEmployeeScopeTests,
);

await runTest(
  "marketing admin override note (the one out-of-band SFE validation is red on every surface that "
    + "shows it, and stays exactly one request)",
  runMarketingAdminOverrideNoteTests,
);

await runTest(
  "recruitment pool filters (every candidate is reachable by exactly one Source option including "
    + "the NULL-source one, the Received filter widens from now outwards, and the profile header is "
    + "not sticky)",
  runRecruitmentPoolFilterTests,
);

await runTest(
  "notification outbox batch window (a retryable row behind a full batch of permanently exhausted "
    + "rows is still drained, and the scan stays bounded)",
  runNotificationOutboxBatchWindowTests,
);

await runTest(
  "notification drain starvation guard (all three retry drains keep exhausted rows out of the due "
    + "window in SQL, and page/limit boundaries stay stable on a total order)",
  runNotificationDrainStarvationGuardTests,
);

await runTest(
  "notification drain health alert (a drain that attempts nothing while work is due is reported "
    + "unhealthy, while an idle, busy, or unprobeable drain stays silent)",
  runNotificationDrainHealthAlertTests,
);

await runTest(
  "mailbox compliance monitor (app-password seal round-trips and detects tampering, and the "
    + "mailbox_monitor resource plus every route is locked to Super Admin, audited, and CSRF-guarded)",
  runMailboxComplianceMonitorTests,
);

const totalMs = testDurationsMs.reduce((sum, t) => sum + t.durationMs, 0);
const slowest = [...testDurationsMs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
console.log(`\n${testDurationsMs.length} test files passed in ${totalMs.toFixed(0)}ms. Slowest:`);
for (const t of slowest) {
  console.log(`  ${t.durationMs.toFixed(0)}ms  ${t.name}`);
}
