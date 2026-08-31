var mongoose = require("mongoose");
var Schema = mongoose.Schema;

var AreasOfInterestSchema = new Schema(
  {
    area_of_interest_name: {
      type: String,
      required: true,
      unique: true,
    },
    category: {
      type: String,
    },
    status: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true },
);

//Export model
module.exports = mongoose.model(
  "user_areas_of_interest",
  AreasOfInterestSchema,
);
