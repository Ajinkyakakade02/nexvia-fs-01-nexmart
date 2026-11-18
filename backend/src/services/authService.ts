import crypto from 'crypto';
import User, { IUser } from '../models/User.js';
import { UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} from '../utils/generateToken.js';

export interface RegisterDTO {
  name: string;
  email: string;
  password: string;
  role?: UserRole;
  phone?: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

const sanitizeUser = (user: IUser) => {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    avatar: user.avatar,
    addresses: user.addresses,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

export const register = async (data: RegisterDTO) => {
  const existingUser = await User.findOne({ email: data.email.toLowerCase() });
  if (existingUser) {
    throw ApiError.conflict('An account with this email already exists');
  }

  // Security rule: admin cannot be self-registered
  let assignedRole = UserRole.CUSTOMER;
  if (data.role === UserRole.VENDOR) {
    assignedRole = UserRole.VENDOR;
  }

  const user = new User({
    name: data.name,
    email: data.email.toLowerCase(),
    passwordHash: data.password, // Pre-save hook hashes it
    role: assignedRole,
    phone: data.phone
  });

  await user.save();

  const tokenPayload = {
    userId: user._id.toString(),
    role: user.role,
    email: user.email
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken
  };
};

export const login = async (data: LoginDTO) => {
  const user = await User.findOne({ email: data.email.toLowerCase() });
  if (!user) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (!user.isActive) {
    throw ApiError.forbidden('Your account has been deactivated. Please contact support.');
  }

  const isPasswordValid = await user.comparePassword(data.password);
  if (!isPasswordValid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const tokenPayload = {
    userId: user._id.toString(),
    role: user.role,
    email: user.email
  };

  const accessToken = generateAccessToken(tokenPayload);
  const refreshToken = generateRefreshToken(tokenPayload);

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken
  };
};

export const refresh = async (refreshTokenString: string) => {
  if (!refreshTokenString) {
    throw ApiError.unauthorized('Refresh token is required');
  }

  try {
    const payload = verifyRefreshToken(refreshTokenString);
    const user = await User.findById(payload.userId);

    if (!user || !user.isActive) {
      throw ApiError.unauthorized('User not found or account is deactivated');
    }

    const tokenPayload = {
      userId: user._id.toString(),
      role: user.role,
      email: user.email
    };

    const newAccessToken = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    return {
      user: sanitizeUser(user),
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  } catch (err: any) {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
};

export const getMe = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return sanitizeUser(user);
};

export const forgotPassword = async (email: string) => {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    // Return success to avoid email enumeration
    return { message: 'If an account exists with this email, password reset instructions have been sent.' };
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await user.save();

  // In production, send email. For development/testing:
  return {
    message: 'If an account exists with this email, password reset instructions have been sent.',
    resetToken // Returned for development convenience
  };
};

export const resetPassword = async (token: string, newPassword: string) => {
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: new Date() }
  });

  if (!user) {
    throw ApiError.badRequest('Password reset token is invalid or has expired');
  }

  user.passwordHash = newPassword; // Pre-save hook hashes it
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  return { message: 'Password has been reset successfully' };
};

