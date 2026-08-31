var mongoose = require("mongoose");
var Schema = mongoose.Schema;

var SpecialitiesSchema = new Schema(
  {
    speciality_name: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: Number,
      default: 1,
    },
    is_other: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

//Export model
module.exports = mongoose.model("user_specialities", SpecialitiesSchema);
