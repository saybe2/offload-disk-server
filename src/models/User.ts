import mongoose, { Schema } from "mongoose";

export type UserRole = "admin" | "user";

export interface UserDoc extends mongoose.Document {
  username: string;
  passwordHash: string;
  role: UserRole;
  quotaBytes: number;
  usedBytes: number;
  transcodeCopiesEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    quotaBytes: { type: Number, required: true },
    usedBytes: { type: Number, required: true, default: 0 },
    transcodeCopiesEnabled: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

export const User = mongoose.model<UserDoc>("User", UserSchema);
