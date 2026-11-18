import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma, { isPrismaAvailable } from '../config/prisma.js';
import User, { IUser } from '../models/User.js';
import { UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken
} from '../utils/generateToken.js';
import { serializePrisma } from '../utils/prismaSerializer.js';

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

const sanitizeUser = (user: any) => {
  return {
    _id: user.id || user._id,
    id: user.id || user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    avatar: user.avatar,
    addresses: user.addresses || [],
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

export const register = async (data: RegisterDTO) => {
  const normalizedEmail = data.email.toLowerCase().trim();

  let assignedRole = UserRole.CUSTOMER;
  if (data.role === UserRole.VENDOR) {
    assignedRole = UserRole.VENDOR;
  }

  if (isPrismaAvailable()) {
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });
    if (existing) {
      throw ApiError.conflict('An account with this email already exists');
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(data.password, salt);

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: normalizedEmail,
        passwordHash,
        role: assignedRole,
        phone: data.phone
      },
      include: { addresses: true }
    });

    const tokenPayload = {
      userId: user.id,
      role: user.role as UserRole,
      email: user.email
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    return {
      user: sanitizeUser(serializePrisma(user)),
      accessToken,
      refreshToken
    };
  }

  // Fallback to Mongoose
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const user = new User({
    name: data.name,
    email: normalizedEmail,
    passwordHash: data.password,
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
  const normalizedEmail = data.email.toLowerCase().trim();

  if (isPrismaAvailable()) {
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { addresses: true }
    });

    if (!user) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    if (!user.isActive) {
      throw ApiError.forbidden('Your account has been deactivated. Please contact support.');
    }

    const isPasswordValid = await bcrypt.compare(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    const tokenPayload = {
      userId: user.id,
      role: user.role as UserRole,
      email: user.email
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    return {
      user: sanitizeUser(serializePrisma(user)),
      accessToken,
      refreshToken
    };
  }

  // Fallback to Mongoose
  const user = await User.findOne({ email: normalizedEmail });
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

    if (isPrismaAvailable()) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { addresses: true }
      });

      if (!user || !user.isActive) {
        throw ApiError.unauthorized('User not found or account is deactivated');
      }

      const tokenPayload = {
        userId: user.id,
        role: user.role as UserRole,
        email: user.email
      };

      const newAccessToken = generateAccessToken(tokenPayload);
      const newRefreshToken = generateRefreshToken(tokenPayload);

      return {
        user: sanitizeUser(serializePrisma(user)),
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      };
    }

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
  if (isPrismaAvailable()) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { addresses: true, vendorProfile: true }
    });
    if (!user) {
      throw ApiError.notFound('User not found');
    }
    return sanitizeUser(serializePrisma(user));
  }

  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return sanitizeUser(user);
};

export const forgotPassword = async (email: string) => {
  const normalizedEmail = email.toLowerCase().trim();

  if (isPrismaAvailable()) {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return { message: 'If an account exists with this email, password reset instructions have been sent.' };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 60 * 60 * 1000)
      }
    });

    return {
      message: 'If an account exists with this email, password reset instructions have been sent.',
      resetToken
    };
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return { message: 'If an account exists with this email, password reset instructions have been sent.' };
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  return {
    message: 'If an account exists with this email, password reset instructions have been sent.',
    resetToken
  };
};

export const resetPassword = async (token: string, newPassword: string) => {
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  if (isPrismaAvailable()) {
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { gt: new Date() }
      }
    });

    if (!user) {
      throw ApiError.badRequest('Password reset token is invalid or has expired');
    }

    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExpires: null
      }
    });

    return { message: 'Password has been reset successfully' };
  }

  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: new Date() }
  });

  if (!user) {
    throw ApiError.badRequest('Password reset token is invalid or has expired');
  }

  user.passwordHash = newPassword;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  return { message: 'Password has been reset successfully' };
};
