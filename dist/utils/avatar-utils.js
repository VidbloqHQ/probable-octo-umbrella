const AVATAR_URLS = [
    "https://res.cloudinary.com/adaeze/image/upload/v1745406833/xgkbh9clm7lwcbb2rm0a.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745406532/oeqiov1ue5ylpythux6k.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404837/vaq22f4hotztogwlnhzq.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404827/qm3i1gdx1ub0bvntksiz.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404819/zhcxy9szj249qxft2fla.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404752/nfpwn5cy2tiklsmg9o5u.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404752/nfpwn5cy2tiklsmg9o5u.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404741/xio2cl8cj8em9cebtyyb.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404621/wwouagdzhxne70kkgaxv.png",
    "https://res.cloudinary.com/adaeze/image/upload/v1745404606/dfzeavyyvmooxyys4knz.png",
];
// Keep track of assigned avatars in the current session
const assignedAvatars = new Map(); // Map userId -> avatarUrl
export function getAvatarForUser(userId) {
    // If this user already has an assigned avatar, return it
    if (assignedAvatars.has(userId)) {
        return assignedAvatars.get(userId);
    }
    // Pick a random avatar
    const randomIndex = Math.floor(Math.random() * AVATAR_URLS.length);
    const avatarUrl = AVATAR_URLS[randomIndex];
    // Store this assignment
    assignedAvatars.set(userId, avatarUrl);
    return avatarUrl;
}
