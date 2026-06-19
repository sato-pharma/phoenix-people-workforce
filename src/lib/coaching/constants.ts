export const coachingMaxScore = 100;
export const coachingScoreItemCount = 20;
export const coachingMinItemScore = 0;
export const coachingMaxItemScore = 5;

// All Excel-imported coaching reports are attributed to this coach — the field
// coaching Training Manager (A-7) who conducts the coaching — regardless of which
// admin runs the upload. Single edit point if the coach of record ever changes.
export const coachingImportCoachHrId = "A-7";

// "critical_red" is stored for backend analytics only. Employee/admin UI should
// display it as the standard red zone label instead of exposing harsh wording.
export const coachingPerformanceZoneDisplayLabels = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement / Good Potential",
} as const;

export type CoachingParameterKey =
  | "knowledge"
  | "call_structure_skills"
  | "business_intelligence"
  | "business_planning"
  | "personal_skills";

export type CoachingScoreItemKey =
  | "medical_patient_knowledge"
  | "product_knowledge"
  | "competitor_knowledge"
  | "opening_patient_profile_attractive_approach"
  | "asking_questions_probing"
  | "presentation_skills"
  | "closing_asking_for_business"
  | "handling_customer_objection"
  | "body_language_tone_of_voice"
  | "professional_pharmacy_feedback"
  | "assertiveness_asking_for_business"
  | "customer_adaptation_relationship"
  | "time_territory_planning"
  | "using_promotional_material"
  | "pre_call_planning"
  | "execution_follow_up"
  | "appearance"
  | "dress_code"
  | "attitude"
  | "discipline";

export type CoachingScoreItemDefinition = {
  category: CoachingParameterKey;
  categoryLabel: string;
  displayOrder: number;
  key: CoachingScoreItemKey;
  label: string;
};

export const coachingParameterLabels: Record<CoachingParameterKey, string> = {
  business_intelligence: "Business Intelligence",
  business_planning: "Business Planning",
  call_structure_skills: "Call Structure Skills",
  knowledge: "Knowledge",
  personal_skills: "Personal Skills",
};

export const coachingScoreItems: CoachingScoreItemDefinition[] = [
  {
    category: "knowledge",
    categoryLabel: coachingParameterLabels.knowledge,
    displayOrder: 1,
    key: "medical_patient_knowledge",
    label: "Medical & Patient/Physician Knowledge",
  },
  {
    category: "knowledge",
    categoryLabel: coachingParameterLabels.knowledge,
    displayOrder: 2,
    key: "product_knowledge",
    label: "Product Knowledge",
  },
  {
    category: "knowledge",
    categoryLabel: coachingParameterLabels.knowledge,
    displayOrder: 3,
    key: "competitor_knowledge",
    label: "Competitor Knowledge",
  },
  {
    category: "call_structure_skills",
    categoryLabel: coachingParameterLabels.call_structure_skills,
    displayOrder: 4,
    key: "opening_patient_profile_attractive_approach",
    label: "Opening, Patient Profile & Attractive Approach",
  },
  {
    category: "call_structure_skills",
    categoryLabel: coachingParameterLabels.call_structure_skills,
    displayOrder: 5,
    key: "asking_questions_probing",
    label: "Asking Questions / Probing",
  },
  {
    category: "call_structure_skills",
    categoryLabel: coachingParameterLabels.call_structure_skills,
    displayOrder: 6,
    key: "presentation_skills",
    label: "Presentation Skills",
  },
  {
    category: "call_structure_skills",
    categoryLabel: coachingParameterLabels.call_structure_skills,
    displayOrder: 7,
    key: "closing_asking_for_business",
    label: "Closing & Asking for Business",
  },
  {
    category: "business_intelligence",
    categoryLabel: coachingParameterLabels.business_intelligence,
    displayOrder: 8,
    key: "handling_customer_objection",
    label: "Handling Customer Objection",
  },
  {
    category: "business_intelligence",
    categoryLabel: coachingParameterLabels.business_intelligence,
    displayOrder: 9,
    key: "body_language_tone_of_voice",
    label: "Body Language & Tone of Voice",
  },
  {
    category: "business_intelligence",
    categoryLabel: coachingParameterLabels.business_intelligence,
    displayOrder: 10,
    key: "professional_pharmacy_feedback",
    label: "Professional Pharmacy Feedback",
  },
  {
    category: "business_intelligence",
    categoryLabel: coachingParameterLabels.business_intelligence,
    displayOrder: 11,
    key: "assertiveness_asking_for_business",
    label: "Assertiveness in Asking for Business",
  },
  {
    category: "business_intelligence",
    categoryLabel: coachingParameterLabels.business_intelligence,
    displayOrder: 12,
    key: "customer_adaptation_relationship",
    label: "Customer Adaptation & Relationship",
  },
  {
    category: "business_planning",
    categoryLabel: coachingParameterLabels.business_planning,
    displayOrder: 13,
    key: "time_territory_planning",
    label: "Time & Territory Planning",
  },
  {
    category: "business_planning",
    categoryLabel: coachingParameterLabels.business_planning,
    displayOrder: 14,
    key: "using_promotional_material",
    label: "Using Promotional Material",
  },
  {
    category: "business_planning",
    categoryLabel: coachingParameterLabels.business_planning,
    displayOrder: 15,
    key: "pre_call_planning",
    label: "Pre-Call Planning",
  },
  {
    category: "business_planning",
    categoryLabel: coachingParameterLabels.business_planning,
    displayOrder: 16,
    key: "execution_follow_up",
    label: "Execution & Follow-Up",
  },
  {
    category: "personal_skills",
    categoryLabel: coachingParameterLabels.personal_skills,
    displayOrder: 17,
    key: "appearance",
    label: "Appearance",
  },
  {
    category: "personal_skills",
    categoryLabel: coachingParameterLabels.personal_skills,
    displayOrder: 18,
    key: "dress_code",
    label: "Dress Code",
  },
  {
    category: "personal_skills",
    categoryLabel: coachingParameterLabels.personal_skills,
    displayOrder: 19,
    key: "attitude",
    label: "Attitude",
  },
  {
    category: "personal_skills",
    categoryLabel: coachingParameterLabels.personal_skills,
    displayOrder: 20,
    key: "discipline",
    label: "Discipline",
  },
];

export const coachingScoreItemKeys = coachingScoreItems.map((item) => item.key);

export function getCoachingScoreItemDefinition(key: string) {
  return coachingScoreItems.find((item) => item.key === key) ?? null;
}
