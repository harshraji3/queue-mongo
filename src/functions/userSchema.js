const mongoose = require("mongoose");
let Schema = mongoose.Schema;

const usersSchema = new Schema(
  {
    first_name: {
      type: String,
      required: true,
    },
    last_name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    is_password_set: {
      type: Boolean,
      default: false,
    },
    // affiliation
    organisation: {
      type: String,
      // required: true,
    },
    admin_identified_organisation: {
      type: String,
    },
    access_type: {
      type: Schema.Types.ObjectId,
      ref: "user_access_types",
      // required: true,
    },
    star_sponsor_id: {
      type: Schema.Types.ObjectId,
      ref: "sponsors_v2",
      // required: true,
    },

    pincode: {
      type: String,
    },
    city: {
      type: String,
    },
    country: {
      type: String,
    },
    mobile_country_code: {
      type: String,
    },
    mobile: {
      type: String,
    },
    is_whatsapp_registered: {
      type: Boolean,
      default: null,
    },
    is_verified: {
      type: Number,
      default: 0,
    },
    email_code: {
      type: String,
    },
    email_code_expiry: {
      type: Date,
    },
    status: {
      type: Number,
      default: 0,
    },
    account_status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    email_hash: {
      type: String,
    },
    registration_number: { type: String },
    speciality: [{ type: Schema.Types.ObjectId, ref: "user_specialities" }],
    admin_identified_speciality: {
      type: Schema.Types.ObjectId,
      ref: "user_specialities",
    },
    area_of_interest: [
      { type: Schema.Types.ObjectId, ref: "user_areas_of_interest" },
    ],
    is_privacy_policy_accepted: { type: Boolean, default: false },
    is_terms_of_use_accepted: { type: Boolean, default: false },
    first_login: { type: Boolean, default: true },

    // for mobile app onboarding flow
    self_signup: { type: Boolean, default: false },

    consents: [
      {
        document: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "legal_documents",
          required: true,
        },
        acceptedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // for email signature
    admin_name: { type: String, default: null },
    admin_email: { type: String, default: null },

    // offline verification details
    verified_by: { type: String },
    verification_status: { type: String },
    verification_notes: { type: String },

    deactivated_at: { type: Date },
    deactivated_by: { type: String },
    deactivation_reason: { type: String },

    expoPushTokens: [{ type: String }],

    // user preferences
    preferences: {
      preferred_cancer_groups: [
        { type: Schema.Types.ObjectId, ref: "cancer_groups" },
      ],
      preferred_cancers: {
        type: Map,
        of: [String],
      },
      preferred_biomarkers: [{ type: String }],
      preferred_products: [{ type: String }],
    },
    // amplitude analytics
    amplitude_id: { type: String, default: null },
    cohort_tags: [{ type: String }],

    // refer via whatsapp
    referral_code: {
      type: String,
      unique: true,
      sparse: true,
    },
    referred_by: {
      type: Schema.Types.ObjectId,
      ref: "users",
    },
  },
  { timestamps: true },
);
usersSchema.index(
  { mobile_country_code: 1, mobile: 1 },
  {
    unique: true,
    partialFilterExpression: { mobile: { $type: "string" } },
  },
);
module.exports = mongoose.model("users", usersSchema);
