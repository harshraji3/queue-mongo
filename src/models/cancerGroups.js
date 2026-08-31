const mongoose = require("mongoose");
var Schema = mongoose.Schema;

const cancerGroupSchema = new Schema({
  cancer_group_name: { type: String, required: true, unique: true },
  cancer_subtypes: [
    {
      type: String,
    },
  ],
  biomarkers_and_products: [
    {
      biomarker_name: { type: String },
      products: [{ type: String }],
    },
  ],
  imageFilename: {
    type: String,
  },
});

module.exports = mongoose.model("cancer_groups", cancerGroupSchema);
